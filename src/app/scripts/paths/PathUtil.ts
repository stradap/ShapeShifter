import { newCommand } from './CommandImpl';
import { newPath } from './PathImpl';
import { Command, Path } from '.';
import { MathUtil, Point } from '../common';

/**
 * Interpolates between a start and end path using the specified fraction.
 *
 * TODO: make it possible to create 'stateless' paths (to save memory on animation frames).
 */
export function interpolate(start: Path, end: Path, fraction: number) {
  if (!start.isMorphableWith(end)) {
    throw new Error('Attempt to interpolate two unmorphable paths');
  }
  const newCommands: Command[] = [];
  start.getCommands().forEach((startCmd, i) => {
    const endCmd = end.getCommands()[i];
    const points: Point[] = [];
    for (let j = 0; j < startCmd.getPoints().length; j++) {
      const p1 = startCmd.getPoints()[j];
      const p2 = endCmd.getPoints()[j];
      if (p1 && p2) {
        // The 'start' point of the first Move command in a path
        // will be undefined. Skip it.
        const px = MathUtil.lerp(p1.x, p2.x, fraction);
        const py = MathUtil.lerp(p1.y, p2.y, fraction);
        points.push(new Point(px, py));
      } else {
        points.push(undefined);
      }
    }
    // TODO: avoid re-generating unique ids on each animation frame.
    newCommands.push(newCommand(startCmd.getSvgChar(), points));
  });
  return newPath(newCommands);
}

/**
 * Sorts a list of path ops in descending order.
 */
export function sortPathOps(ops: Array<{ subIdx: number, cmdIdx: number }>) {
  return ops.sort(
    ({ subIdx: s1, cmdIdx: c1 }, { subIdx: s2, cmdIdx: c2 }) => {
      // Perform higher index splits first so that we don't alter the
      // indices of the lower index split operations.
      return s1 !== s2 ? s2 - s1 : c2 - c1;
    });
}
