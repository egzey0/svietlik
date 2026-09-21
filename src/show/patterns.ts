export const OUTPUTS = [
  'fl_drl', 'fl_low', 'fl_high', 'fl_turn', 'fl_ring',
  'fr_drl', 'fr_low', 'fr_high', 'fr_turn', 'fr_ring',
  'rl_tail', 'rl_brake', 'rl_turn',
  'rr_tail', 'rr_brake', 'rr_turn',
] as const;

export type Output = (typeof OUTPUTS)[number];

/** brightness per output, 0..255. Outputs left out keep their previous level. */
export type Levels = Partial<Record<Output, number>>;

export interface Step {
  levels: Levels;
  holdMs: number;
}

export const set = (outputs: readonly Output[], level: number): Levels =>
  Object.fromEntries(outputs.map((o) => [o, level]));

export const dark = (): Levels => set(OUTPUTS, 0);

export function flash(outputs: Output[], times: number, onMs = 120, offMs = 120): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < times; i++) {
    steps.push({ levels: set(outputs, 255), holdMs: onMs }, { levels: set(outputs, 0), holdMs: offMs });
  }
  return steps;
}

/** one output lit at a time, in the given order */
export function chase(outputs: Output[], onMs = 90): Step[] {
  return outputs.map((o) => ({ levels: { ...set(outputs, 0), [o]: 255 }, holdMs: onMs }));
}

function ramp(step: number): number[] {
  const up: number[] = [];
  for (let l = 0; l <= 255; l += step) up.push(l);
  return up;
}

export function breathe(outputs: Output[], stepMs = 40): Step[] {
  const up = ramp(17);
  return [...up, ...up.toReversed()].map((l) => ({ levels: set(outputs, l), holdMs: stepMs }));
}

/** fade in, hold at full, fade out */
export function swell(outputs: Output[], stepMs = 90, holdMs = 1600): Step[] {
  const up = ramp(15).map((l) => ({ levels: set(outputs, l), holdMs: stepMs }));
  return [...up, { levels: set(outputs, 255), holdMs }, ...up.toReversed()];
}

export function alternate(a: Output[], b: Output[], onMs = 260, gapMs = 140): Step[] {
  const off = set([...a, ...b], 0);
  return [
    { levels: { ...off, ...set(a, 255) }, holdMs: onMs },
    { levels: off, holdMs: gapMs },
    { levels: { ...off, ...set(b, 255) }, holdMs: onMs },
    { levels: off, holdMs: gapMs },
  ];
}

/** a fades up while b fades down, then back */
export function crossfade(a: Output[], b: Output[], count = 24, stepMs = 45): Step[] {
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    const level = Math.round((t < 0.5 ? t * 2 : (1 - t) * 2) * 255);
    return { levels: { ...set(a, level), ...set(b, 255 - level) }, holdMs: stepMs };
  });
}
