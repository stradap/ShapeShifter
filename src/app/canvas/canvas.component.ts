import * as _ from 'lodash';
import {
  Component, AfterViewInit, OnDestroy, ElementRef, HostListener,
  ViewChild, ViewChildren, Input, Output, EventEmitter
} from '@angular/core';
import {
  Layer, PathLayer, ClipPathLayer, GroupLayer,
  VectorLayer, PathCommand, EditorType, SubPathCommand, DrawCommand
} from '../scripts/model';
import * as $ from 'jquery';
import * as erd from 'element-resize-detector';
import { Point, Matrix, Projection, MathUtil, ColorUtil } from '../scripts/common';
import { AnimationService } from '../services/animation.service';
import { LayerStateService } from '../services/layerstate.service';
import { Subscription } from 'rxjs/Subscription';
import { arcToBeziers } from '../scripts/svg';
import { SelectionService, Selection } from '../services/selection.service';

const ELEMENT_RESIZE_DETECTOR = erd();

// TODO(alockwood): add offscreen canvas to implement alpha
@Component({
  selector: 'app-canvas',
  templateUrl: './canvas.component.html',
  styleUrls: ['./canvas.component.scss']
})
export class CanvasComponent implements AfterViewInit, OnDestroy {
  @Input() editorType: EditorType;
  @ViewChild('renderingCanvas') private renderingCanvasRef: ElementRef;

  private vectorLayer: VectorLayer;
  private shouldLabelPoints_ = false;
  private canvasContainerSize: number;
  private canvas: JQuery;
  private scale: number;
  private backingStoreScale: number;
  private isViewInit = false;
  private closestProjectionInfo: ProjectionInfo;
  private closestPathLayerId: string;
  private subscriptions: Subscription[] = [];
  private pathPointRadius: number;
  private currentSelections: Selection[] = [];

  constructor(
    private elementRef: ElementRef,
    private layerStateService: LayerStateService,
    private animationService: AnimationService,
    private selectionService: SelectionService) { }

  ngAfterViewInit() {
    this.isViewInit = true;
    this.canvas = $(this.renderingCanvasRef.nativeElement);
    this.canvasContainerSize = this.elementRef.nativeElement.getBoundingClientRect().width;
    ELEMENT_RESIZE_DETECTOR.listenTo(this.elementRef.nativeElement, element => {
      const canvasContainerSize = element.getBoundingClientRect().width;
      if (this.canvasContainerSize !== canvasContainerSize) {
        this.canvasContainerSize = canvasContainerSize;
        this.resizeAndDraw();
      }
    });
    this.subscriptions.push(
      this.layerStateService.addListener(
        this.editorType, vl => {
          if (vl) {
            const oldVl = this.vectorLayer;
            const didWidthChange = !oldVl || oldVl.width !== vl.width;
            const didHeightChange = !oldVl || oldVl.height !== vl.height;
            this.vectorLayer = vl;
            if (didWidthChange || didHeightChange) {
              this.resizeAndDraw();
            } else {
              this.draw();
            }
          }
        }));
    if (this.editorType === EditorType.Preview) {
      this.subscriptions.push(
        this.animationService.addListener(fraction => {
          if (this.vectorLayer) {
            // TODO(alockwood): if vector layer is undefined, then clear the canvas
            const startLayer = this.layerStateService.getData(EditorType.Start);
            const endLayer = this.layerStateService.getData(EditorType.End);
            this.vectorLayer.walk(layer => {
              if (layer instanceof PathLayer) {
                const start = startLayer.findLayerById(layer.id) as PathLayer;
                const end = endLayer.findLayerById(layer.id) as PathLayer;
                layer.pathData =
                  layer.pathData.interpolate(start.pathData, end.pathData, fraction);
              }
            });
            this.draw();
          }
        }));
    } else {
      this.subscriptions.push(
        this.selectionService.addListener(
          this.editorType, (selections: Selection[]) => {
            this.currentSelections = selections;
            this.draw();
          }));
    }
  }

  ngOnDestroy() {
    ELEMENT_RESIZE_DETECTOR.removeAllListeners(this.elementRef.nativeElement);
    this.subscriptions.forEach(s => s.unsubscribe());
  }

  @Input()
  set shouldLabelPoints(shouldLabelPoints: boolean) {
    if (this.shouldLabelPoints_ !== shouldLabelPoints) {
      this.shouldLabelPoints_ = shouldLabelPoints;
      this.draw();
    }
  }

  private resizeAndDraw() {
    if (!this.isViewInit || !this.vectorLayer) {
      return;
    }

    const containerAspectRatio = this.canvasContainerSize / this.canvasContainerSize;
    const vectorAspectRatio = this.vectorLayer.width / (this.vectorLayer.height || 1);

    if (vectorAspectRatio > containerAspectRatio) {
      this.scale = this.canvasContainerSize / this.vectorLayer.width;
    } else {
      this.scale = this.canvasContainerSize / this.vectorLayer.height;
    }
    this.scale = Math.max(1, Math.floor(this.scale));
    this.backingStoreScale = this.scale * (window.devicePixelRatio || 1);

    this.canvas
      .attr({
        width: this.vectorLayer.width * this.backingStoreScale,
        height: this.vectorLayer.height * this.backingStoreScale,
      })
      .css({
        width: this.vectorLayer.width * this.scale,
        height: this.vectorLayer.height * this.scale,
      });

    this.pathPointRadius = this.backingStoreScale * 0.6;
    this.draw();
  }

  draw() {
    if (!this.isViewInit || !this.vectorLayer) {
      return;
    }

    // Draw the vector layer to the canvas.
    const context = (this.canvas.get(0) as HTMLCanvasElement).getContext('2d');
    context.save();
    context.scale(this.backingStoreScale, this.backingStoreScale);
    context.clearRect(0, 0, this.vectorLayer.width, this.vectorLayer.height);
    this.traverseLayers({
      layer: this.vectorLayer,
      transforms: [],
      ctx: context,
      pathFunc: this.drawPathLayer,
      clipPathFunc: (args: LayerArgs<ClipPathLayer>) => {
        executePathData(args.layer, args.ctx, args.transforms);
        args.ctx.clip();
      },
    });
    context.restore();

    // Draw any selected paths.
    if (this.currentSelections.length) {
      context.save();
      context.scale(this.backingStoreScale, this.backingStoreScale);
      this.traverseLayers({
        layer: this.vectorLayer,
        transforms: [],
        ctx: context,
        pathFunc: (args: LayerArgs<PathLayer>) => {
          const selections = this.currentSelections.filter(s => s.pathId === args.layer.id);
          if (!selections.length) {
            return;
          }
          const dcmds = selections.map(s => {
            return args.layer.pathData.subPathCommands[s.subPathIdx].commands[s.drawIdx];
          });

          executeDrawCommands(dcmds, args.ctx, args.transforms, true);

          args.ctx.save();
          args.ctx.lineWidth = 6 / this.scale; // 2px
          args.ctx.strokeStyle = '#fff';
          args.ctx.lineCap = 'round';
          args.ctx.stroke();
          args.ctx.strokeStyle = '#2196f3';
          args.ctx.lineWidth = 3 / this.scale; // 2px
          args.ctx.stroke();
          args.ctx.restore();
        },
      });
      context.restore();
    }

    // Draw any labeled points to the canvas.
    if (this.shouldLabelPoints_ && this.editorType !== EditorType.Preview) {
      this.traverseLayers({
        layer: this.vectorLayer,
        transforms: [new Matrix(this.backingStoreScale, 0, 0, this.backingStoreScale, 0, 0)],
        ctx: context,
        pathFunc: (args: LayerArgs<PathLayer>) => {
          const pathDataPoints = _.flatMap(args.layer.pathData.subPathCommands, scmd => {
            return scmd.points as { point: Point, isSplit: boolean }[];
          });

          const matrices = args.transforms.slice().reverse();
          args.ctx.save();
          for (let i = pathDataPoints.length - 1; i >= 0; i--) {
            const p = MathUtil.transform(pathDataPoints[i].point, ...matrices);
            const color = i === 0 ? 'blue' : pathDataPoints[i].isSplit ? 'purple' : 'green';
            const radius = this.pathPointRadius * (pathDataPoints[i].isSplit ? 0.8 : 1);
            args.ctx.beginPath();
            args.ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI, false);
            args.ctx.fillStyle = color;
            args.ctx.fill();
            args.ctx.beginPath();
            args.ctx.fillStyle = 'white';
            args.ctx.font = radius + 'px serif';
            const text = (i + 1).toString();
            const width = args.ctx.measureText(text).width;
            // TODO(alockwood): is there a better way to get the height?
            const height = args.ctx.measureText('o').width;
            args.ctx.fillText(text, p.x - width / 2, p.y + height / 2);
            args.ctx.fill();
          }
          args.ctx.restore();
        }
      });
    }

    if (this.closestProjectionInfo) {
      this.traverseLayers({
        layer: this.vectorLayer,
        transforms: [new Matrix(this.backingStoreScale, 0, 0, this.backingStoreScale, 0, 0)],
        ctx: context,
        pathFunc: (args: LayerArgs<PathLayer>) => {
          if (args.layer.id !== this.closestPathLayerId) {
            return;
          }
          args.ctx.save();
          const matrices = args.transforms.slice().reverse();
          const proj = this.closestProjectionInfo.projection;
          const p = MathUtil.transform({ x: proj.x, y: proj.y }, ...matrices);
          args.ctx.beginPath();
          args.ctx.arc(p.x, p.y, this.pathPointRadius, 0, 2 * Math.PI, false);
          args.ctx.fillStyle = 'red';
          args.ctx.fill();
          args.ctx.restore();
        },
      });
    }

    // draw pixel grid
    if (this.scale > 4) {
      context.fillStyle = 'rgba(128, 128, 128, .25)';
      for (let x = 1; x < this.vectorLayer.width; x++) {
        context.fillRect(
          x * this.backingStoreScale - 0.5 * (window.devicePixelRatio || 1),
          0,
          1 * (window.devicePixelRatio || 1),
          this.vectorLayer.height * this.backingStoreScale);
      }
      for (let y = 1; y < this.vectorLayer.height; y++) {
        context.fillRect(
          0,
          y * this.backingStoreScale - 0.5 * (window.devicePixelRatio || 1),
          this.vectorLayer.width * this.backingStoreScale,
          1 * (window.devicePixelRatio || 1));
      }
    }
  }

  // TODO(alockwood): update layer.pathData.length so that it reflects transforms such as scale
  private drawPathLayer({layer, ctx, transforms}: LayerArgs<PathLayer>) {
    ctx.save();

    executePathData(layer, ctx, transforms);

    // draw the actual layer
    ctx.strokeStyle = ColorUtil.androidToCssColor(layer.strokeColor, layer.strokeAlpha);
    ctx.lineWidth = layer.strokeWidth;
    ctx.fillStyle = ColorUtil.androidToCssColor(layer.fillColor, layer.fillAlpha);
    ctx.lineCap = layer.strokeLinecap;
    ctx.lineJoin = layer.strokeLinejoin;
    ctx.miterLimit = layer.strokeMiterLimit || 4;

    if (layer.trimPathStart !== 0 || layer.trimPathEnd !== 1 || layer.trimPathOffset !== 0) {
      // Calculate the visible fraction of the trimmed path. If trimPathStart
      // is greater than trimPathEnd, then the result should be the combined
      // length of the two line segments: [trimPathStart,1] and [0,trimPathEnd].
      let shownFraction = layer.trimPathEnd - layer.trimPathStart;
      if (layer.trimPathStart > layer.trimPathEnd) {
        shownFraction += 1;
      }
      // Calculate the dash array. The first array element is the length of
      // the trimmed path and the second element is the gap, which is the
      // difference in length between the total path length and the visible
      // trimmed path length.
      ctx.setLineDash([
        shownFraction * layer.pathData.pathLength,
        (1 - shownFraction + 0.001) * layer.pathData.pathLength
      ]);
      // The amount to offset the path is equal to the trimPathStart plus
      // trimPathOffset. We mod the result because the trimmed path
      // should wrap around once it reaches 1.
      ctx.lineDashOffset =
        layer.pathData.pathLength * (1 - ((layer.trimPathStart + layer.trimPathOffset) % 1));
    } else {
      ctx.setLineDash([]);
    }
    if (layer.strokeColor && layer.strokeWidth && layer.trimPathStart !== layer.trimPathEnd) {
      ctx.stroke();
    }
    if (layer.fillColor) {
      ctx.fill();
    }
    ctx.restore();
  }

  // TODO(alockwood): don't split if user control clicks (or double clicks on mac)
  @HostListener('mousedown', ['$event'])
  onMouseDown(event) {
    const canvasOffset = this.canvas.offset();
    const x = (event.pageX - canvasOffset.left) / this.scale;
    const y = (event.pageY - canvasOffset.top) / this.scale;
    const mouseDown = new Point(x, y);

    if (this.editorType === EditorType.Preview) {
      return;
    }

    this.findClosestProjectionInfo(mouseDown);

    if (this.closestProjectionInfo) {
      const pathLayer = this.vectorLayer.findLayerById(this.closestPathLayerId) as PathLayer;
      pathLayer.pathData = this.closestProjectionInfo.split();
      this.layerStateService.setData(this.editorType, this.vectorLayer);
      this.closestProjectionInfo = undefined;
    }
  }

  // TODO(alockwood): need to transform the mouse point coordinates using the group transforms
  @HostListener('mousemove', ['$event'])
  onMouseMove(event) {
    const canvasOffset = this.canvas.offset();
    const x = (event.pageX - canvasOffset.left) / this.scale;
    const y = (event.pageY - canvasOffset.top) / this.scale;
    const mouseMove = new Point(x, y);

    if (this.editorType === EditorType.Preview) {
      return;
    }

    this.findClosestProjectionInfo(mouseMove);

    if (this.closestProjectionInfo) {
      this.draw();
    }
  }

  private findClosestProjectionInfo(point: Point) {
    let closestProjectionInfo: ProjectionInfo;
    let closestPathLayerId: string;

    this.traverseLayers({
      layer: this.vectorLayer,
      transforms: [],
      pathFunc: (args: LayerArgs<PathLayer>) => {
        const reversedMatrices = args.transforms.slice().reverse();
        const transformedPoint = MathUtil.transform(point, ...reversedMatrices);
        const projectionInfo = args.layer.pathData.project(transformedPoint);
        if (projectionInfo
          && (!closestProjectionInfo
            || projectionInfo.projection.d < closestProjectionInfo.projection.d)) {
          closestProjectionInfo = projectionInfo;
          closestPathLayerId = args.layer.id;
        }
      },
    });

    if (this.closestProjectionInfo !== closestProjectionInfo) {
      this.closestProjectionInfo = closestProjectionInfo;
      this.closestPathLayerId = closestPathLayerId;
    }
  }

  @HostListener('mouseleave', ['$event'])
  onMouseLeave(event) {
    if (this.closestProjectionInfo) {
      this.closestProjectionInfo = undefined;
      this.draw();
    }
  }

  /**
   * Recursively traverses a vector layer, applying group transforms at each level of the
   * tree so that children layers can draw their content to the canvas properly.
   */
  private traverseLayers(args: LayerArgs<Layer>) {
    const {layer, ctx, transforms, pathFunc, clipPathFunc} = args;
    if (layer instanceof VectorLayer || layer instanceof GroupLayer) {
      const matrices = [];
      if (layer instanceof GroupLayer) {
        const cosr = Math.cos(layer.rotation * Math.PI / 180);
        const sinr = Math.sin(layer.rotation * Math.PI / 180);
        matrices.push(...[
          new Matrix(1, 0, 0, 1, layer.pivotX, layer.pivotY),
          new Matrix(1, 0, 0, 1, layer.translateX, layer.translateY),
          new Matrix(cosr, sinr, -sinr, cosr, 0, 0),
          new Matrix(layer.scaleX, 0, 0, layer.scaleY, 0, 0),
          new Matrix(1, 0, 0, 1, -layer.pivotX, -layer.pivotY)
        ]);
      }
      transforms.splice(transforms.length, 0, ...matrices);
      layer.children.forEach(
        l => this.traverseLayers({ layer: l, ctx, transforms, pathFunc, clipPathFunc }));
      transforms.splice(-matrices.length, matrices.length);
    } else if (layer instanceof PathLayer) {
      if (pathFunc) {
        pathFunc.call(this, { layer, ctx, transforms });
      }
    } else if (layer instanceof ClipPathLayer) {
      if (clipPathFunc) {
        clipPathFunc.call(this, { layer, ctx, transforms });
      }
    }
  }
}

/** Draws an command on the specified canvas context. */
function executePathData(
  layer: PathLayer | ClipPathLayer,
  ctx: CanvasRenderingContext2D,
  transforms: Matrix[],
  isDrawingSelection?: boolean) {

  const drawCommands =
    _.flatMap(layer.pathData.subPathCommands, s => s.commands as DrawCommand[]);
  executeDrawCommands(drawCommands, ctx, transforms, isDrawingSelection);
}

function executeDrawCommands(
  drawCommands: DrawCommand[],
  ctx: CanvasRenderingContext2D,
  transforms: Matrix[],
  isDrawingSelection?: boolean) {

  ctx.save();
  transforms.forEach(m => ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f));

  ctx.beginPath();
  drawCommands.forEach(d => {
    const start = d.start;
    const end = d.end;

    // TODO: remove this... or at least only use it for selections?
    // this probably doesn't work for close path commands too?
    if (isDrawingSelection && d.svgChar !== 'M') {
      ctx.moveTo(start.x, start.y);
    }

    if (d.svgChar === 'M') {
      ctx.moveTo(end.x, end.y);
    } else if (d.svgChar === 'L') {
      ctx.lineTo(end.x, end.y);
    } else if (d.svgChar === 'Q') {
      ctx.quadraticCurveTo(
        d.points[1].x, d.points[1].y,
        d.points[2].x, d.points[2].y);
    } else if (d.svgChar === 'C') {
      ctx.bezierCurveTo(
        d.points[1].x, d.points[1].y,
        d.points[2].x, d.points[2].y,
        d.points[3].x, d.points[3].y);
    } else if (d.svgChar === 'Z') {
      ctx.closePath();
    } else if (d.svgChar === 'A') {
      executeArcCommand(ctx, d.args);
    }
  });

  ctx.restore();
}

/** Draws an elliptical arc on the specified canvas context. */
function executeArcCommand(ctx: CanvasRenderingContext2D, arcArgs: ReadonlyArray<number>) {
  const [currentPointX, currentPointY,
    rx, ry, xAxisRotation,
    largeArcFlag, sweepFlag,
    tempPoint1X, tempPoint1Y] = arcArgs;

  if (currentPointX === tempPoint1X && currentPointY === tempPoint1Y) {
    // degenerate to point
    return;
  }

  if (rx === 0 || ry === 0) {
    // degenerate to line
    ctx.lineTo(tempPoint1X, tempPoint1Y);
    return;
  }

  const bezierCoords = arcToBeziers({
    startX: currentPointX,
    startY: currentPointY,
    rx, ry, xAxisRotation,
    largeArcFlag, sweepFlag,
    endX: tempPoint1X,
    endY: tempPoint1Y,
  });

  for (let i = 0; i < bezierCoords.length; i += 8) {
    ctx.bezierCurveTo(
      bezierCoords[i + 2], bezierCoords[i + 3],
      bezierCoords[i + 4], bezierCoords[i + 5],
      bezierCoords[i + 6], bezierCoords[i + 7]);
  }
}

interface LayerArgs<T extends Layer> {
  layer: T;
  transforms: Matrix[];
  ctx?: CanvasRenderingContext2D;
  pathFunc?: (args: LayerArgs<PathLayer>) => void;
  clipPathFunc?: (args: LayerArgs<ClipPathLayer>) => void;
}

interface ProjectionInfo {
  projection: Projection;
  split: () => PathCommand;
}
