import { OUTPUTS, alternate, breathe, chase, crossfade, dark, flash, set, swell, type Output, type Step } from './patterns.ts';

export interface Show {
  id: string;
  name: string;
  loop: boolean;
  /**
   * fem: on/off lamp functions through the FEM, reaches every lamp on the car.
   * fle: pwm through the headlight modules, front only but dimmable.
   */
  via: 'fem' | 'fle';
  steps(): Step[];
}

const all = [...OUTPUTS];
const headlights: Output[] = ['fl_low', 'fl_high', 'fr_low', 'fr_high'];
const drls: Output[] = ['fl_drl', 'fr_drl'];
const headLeft: Output[] = ['fl_drl', 'fl_low'];
const headRight: Output[] = ['fr_drl', 'fr_low'];
const turnsLeft: Output[] = ['fl_turn', 'rl_turn'];
const turnsRight: Output[] = ['fr_turn', 'rr_turn'];
// clockwise around the car
const turns: Output[] = ['fl_turn', 'fr_turn', 'rr_turn', 'rl_turn'];
const frontToBack: Output[] = ['fl_drl', 'fr_drl', 'fl_low', 'fr_low', 'rl_tail', 'rr_tail'];

export const SHOWS: Show[] = [
  { id: 'flash2', name: 'Twin flash', loop: false, via: 'fem', steps: () => flash(all, 2) },
  { id: 'flash3', name: 'Triple flash', loop: false, via: 'fem', steps: () => flash(all, 3) },
  { id: 'head-flash', name: 'Headlight flash', loop: false, via: 'fem', steps: () => flash(headlights, 3) },
  {
    id: 'welcome',
    name: 'Welcome',
    loop: false,
    via: 'fem',
    steps: () => [...chase(frontToBack, 160), { levels: set(all, 255), holdMs: 600 }, { levels: dark(), holdMs: 0 }],
  },
  {
    id: 'crossfire',
    name: 'Crossfire',
    loop: true,
    via: 'fem',
    steps: () => [
      { levels: { ...set(drls, 0), fl_high: 255, fr_high: 255 }, holdMs: 120 },
      { levels: { ...set(drls, 255), fl_high: 0, fr_high: 0 }, holdMs: 120 },
    ],
  },
  { id: 'side-wink', name: 'Side wink', loop: true, via: 'fem', steps: () => alternate(turnsRight, turnsLeft, 600, 250) },
  { id: 'orbit', name: 'Orbit', loop: true, via: 'fem', steps: () => chase(turns, 520) },
  { id: 'scanner', name: 'Scanner', loop: true, via: 'fem', steps: () => chase([...turns, 'rr_turn', 'fr_turn'], 520) },
  { id: 'runway', name: 'Runway', loop: true, via: 'fem', steps: () => chase(frontToBack) },
  { id: 'drift', name: 'Drift', loop: true, via: 'fem', steps: () => chase(frontToBack, 300) },
  {
    id: 'carnival',
    name: 'Carnival',
    loop: true,
    via: 'fem',
    steps: () => [
      { levels: { ...dark(), fl_drl: 255, rr_tail: 255 }, holdMs: 150 },
      { levels: { ...dark(), fr_drl: 255, rl_tail: 255 }, holdMs: 150 },
    ],
  },

  { id: 'breathe', name: 'Breathe', loop: true, via: 'fle', steps: () => breathe(drls, 60) },
  { id: 'ember', name: 'Ember', loop: true, via: 'fle', steps: () => breathe(drls, 120) },
  { id: 'pulse', name: 'Pulse', loop: true, via: 'fle', steps: () => breathe(headlights, 110) },
  { id: 'sunrise', name: 'Sunrise', loop: true, via: 'fle', steps: () => swell(drls) },
  { id: 'glide', name: 'Glide', loop: true, via: 'fle', steps: () => crossfade(['fl_drl'], ['fr_drl'], 48, 110) },
  { id: 'seesaw', name: 'Seesaw', loop: true, via: 'fle', steps: () => crossfade(headLeft, headRight) },
  { id: 'head-wink', name: 'Headlight wink', loop: true, via: 'fle', steps: () => alternate(headRight, headLeft, 300, 160) },
  { id: 'split-strobe', name: 'Split strobe', loop: true, via: 'fle', steps: () => alternate(headLeft, headRight, 90, 40) },
  {
    id: 'lumen',
    name: 'Lumen',
    loop: true,
    via: 'fle',
    steps: () => [...breathe(drls), ...flash(headlights, 2, 80, 80)],
  },
];

export const findShow = (id: string) => SHOWS.find((s) => s.id === id);

/** Validate a show that came from outside (JSON, user input) before it gets near the car. */
export function parseShow(raw: unknown): Show {
  const bad = (why: string) => new Error(`invalid show: ${why}`);
  if (!raw || typeof raw !== 'object') throw bad('not an object');
  const { id, name, loop, via, steps } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id)) throw bad('id');
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw bad('name');
  if (via !== 'fem' && via !== 'fle') throw bad('via must be fem or fle');
  if (!Array.isArray(steps) || !steps.length || steps.length > 2000) throw bad('steps');

  const known = new Set<string>(OUTPUTS);
  const parsed: Step[] = steps.map((s, i) => {
    const holdMs = s?.holdMs;
    if (!Number.isFinite(holdMs) || holdMs < 20 || holdMs > 60000) throw bad(`step ${i}: holdMs`);
    const entries = Object.entries(s.levels ?? {});
    for (const [output, level] of entries) {
      if (!known.has(output)) throw bad(`step ${i}: unknown output ${output}`);
      if (!Number.isFinite(level) || (level as number) < 0 || (level as number) > 255) throw bad(`step ${i}: level`);
    }
    return { levels: Object.fromEntries(entries), holdMs };
  });
  return { id, name: name.trim(), loop: loop === true, via, steps: () => parsed };
}
