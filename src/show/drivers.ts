import { femLamp, fleLeds, fleStop } from '../bmw/commands.ts';
import { send, type Profile } from '../bmw/identify.ts';
import { LAMP } from '../bmw/tables.ts';
import type { UdsLink } from '../transport/client.ts';
import { Session, session } from '../uds.ts';
import type { Levels, Output } from './patterns.ts';
import type { Show } from './shows.ts';

/** Turns frames into commands. The player guarantees release() after begin(). */
export interface Driver {
  begin(): Promise<void>;
  frame(levels: Levels, holdMs: number): Promise<void>;
  release(): Promise<void>;
}

// Some modules accept the light commands in the default session and refuse
// the switch, so a failed session change is not a reason to give up.
const extended = (link: UdsLink, ecu: number) => send(link, ecu, session(Session.extended)).catch(() => {});

// The FEM only does on/off, so a level above this counts as on.
const ON = 20;

// Lamp functions are per car, not per corner: asking for fl_high lights both.
const LAMP_OUTPUTS: [number, Output[]][] = [
  [LAMP.highBeam, ['fl_high', 'fr_high']],
  [LAMP.lowBeam, ['fl_low', 'fr_low']],
  [LAMP.drl, ['fl_drl', 'fr_drl', 'fl_ring', 'fr_ring']],
  [LAMP.turnLeft, ['fl_turn', 'rl_turn']],
  [LAMP.turnRight, ['fr_turn', 'rr_turn']],
  [LAMP.brake, ['rl_brake', 'rr_brake']],
  [LAMP.position, ['rl_tail', 'rr_tail']],
];

export function femDriver(link: UdsLink, body: number): Driver {
  return {
    async begin() {
      await extended(link, body);
    },
    async frame(levels, holdMs) {
      for (const [lamp, outputs] of LAMP_OUTPUTS) {
        if (!outputs.some((o) => (levels[o] ?? 0) > ON)) continue;
        // a bit longer than the step so a lamp that stays on does not flicker between frames
        await send(link, body, femLamp(lamp, Math.max(holdMs, 60) + 60));
      }
    },
    async release() {
      await send(link, body, femLamp(0, 0));
    },
  };
}

const LEFT: Output[] = ['fl_drl', 'fl_low', 'fl_high', 'fl_ring'];
const RIGHT: Output[] = ['fr_drl', 'fr_low', 'fr_high', 'fr_ring'];

const pwm = (levels: Levels, side: Output[]) => Math.round((Math.max(0, ...side.map((o) => levels[o] ?? 0)) / 255) * 100);

export function fleDriver(link: UdsLink, left: number, right: number): Driver {
  return {
    async begin() {
      await extended(link, left);
      await extended(link, right);
    },
    async frame(levels) {
      await send(link, left, fleLeds(pwm(levels, LEFT)));
      await send(link, right, fleLeds(pwm(levels, RIGHT)));
    },
    async release() {
      // stop both even if the first one fails, a headlight stuck in the routine is worse than an error
      const results = await Promise.allSettled([send(link, left, fleStop()), send(link, right, fleStop())]);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw new Error(`headlights may not be restored: ${failed.reason.message}`);
    },
  };
}

export function driverFor(show: Show, link: UdsLink, profile: Profile): Driver {
  if (show.via === 'fle') {
    if (profile.left === undefined || profile.right === undefined) throw new Error(`${show.id} needs both FLE headlight modules`);
    return fleDriver(link, profile.left, profile.right);
  }
  if (profile.body === undefined) throw new Error(`${show.id} needs a FEM_20`);
  return femDriver(link, profile.body);
}
