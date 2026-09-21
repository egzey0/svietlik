import type { Levels, Output } from '../src/show/patterns.ts';

const WHITE = [255, 244, 214];
const AMBER = [255, 150, 0];
const RED = [255, 30, 20];

const color = (o: Output) => (o.endsWith('turn') ? AMBER : o.startsWith('r') ? RED : WHITE);

function lamp(levels: Levels, o: Output): string {
  const k = 0.12 + 0.88 * ((levels[o] ?? 0) / 255);
  const [r, g, b] = color(o).map((c) => Math.round(c * k));
  return `\x1b[38;2;${r};${g};${b}m██\x1b[0m`;
}

const FRONT_LEFT: Output[] = ['fl_turn', 'fl_drl', 'fl_ring', 'fl_low', 'fl_high'];
const FRONT_RIGHT: Output[] = ['fr_high', 'fr_low', 'fr_ring', 'fr_drl', 'fr_turn'];
const REAR_LEFT: Output[] = ['rl_turn', 'rl_tail', 'rl_brake'];
const REAR_RIGHT: Output[] = ['rr_brake', 'rr_tail', 'rr_turn'];

export const HEIGHT = 7;

/** top-down view of the car, nose up */
export function renderCar(levels: Levels): string {
  const row = (left: Output[], right: Output[], gap: number) =>
    ' │ ' + left.map((o) => lamp(levels, o)).join(' ') + ' '.repeat(gap) + right.map((o) => lamp(levels, o)).join(' ') + ' │';
  const width = 5 * 2 + 4 + 4 + 5 * 2 + 4;
  const blank = ' │' + ' '.repeat(width + 2) + '│';
  return [
    ' ╭' + '─'.repeat(width + 2) + '╮',
    row(FRONT_LEFT, FRONT_RIGHT, 4),
    blank,
    blank,
    blank,
    row(REAR_LEFT, REAR_RIGHT, 16),
    ' ╰' + '─'.repeat(width + 2) + '╯',
  ].join('\n');
}
