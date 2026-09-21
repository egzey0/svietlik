import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hex } from '../src/bytes.ts';
import { driverFor, type Driver } from '../src/show/drivers.ts';
import { OUTPUTS, type Levels } from '../src/show/patterns.ts';
import { Player } from '../src/show/player.ts';
import { SHOWS, findShow, parseShow, type Show } from '../src/show/shows.ts';
import type { UdsLink } from '../src/transport/client.ts';

function recorder(fail?: (ecu: number, uds: Uint8Array) => boolean) {
  const sent: string[] = [];
  const link: UdsLink = {
    close() {},
    async request(ecu, uds) {
      sent.push(`${ecu.toString(16)}: ${hex(uds)}`);
      if (fail?.(ecu, uds)) return { ok: false, sid: uds[0], data: new Uint8Array(0), nrc: 0x22 };
      return { ok: true, sid: uds[0], data: new Uint8Array(0) };
    },
  };
  return { link, sent };
}

const quick: Show = {
  id: 'quick',
  name: 'Quick',
  loop: false,
  via: 'fem',
  steps: () => [
    { levels: { fl_low: 255 }, holdMs: 1 },
    { levels: { fl_low: 0, rl_brake: 255 }, holdMs: 1 },
  ],
};

test('built in shows are well formed', () => {
  const ids = new Set(SHOWS.map((s) => s.id));
  assert.equal(ids.size, SHOWS.length);
  for (const show of SHOWS) {
    const steps = show.steps();
    assert.ok(steps.length > 0, show.id);
    for (const step of steps) {
      assert.ok(step.holdMs >= 0, show.id);
      for (const [output, level] of Object.entries(step.levels)) {
        assert.ok((OUTPUTS as readonly string[]).includes(output), `${show.id}: ${output}`);
        assert.ok(level >= 0 && level <= 255, show.id);
      }
    }
  }
});

test('fle shows stay on the front of the car', () => {
  for (const show of SHOWS.filter((s) => s.via === 'fle')) {
    for (const step of show.steps()) {
      for (const output of Object.keys(step.levels)) assert.match(output, /^f[lr]_/, show.id);
    }
  }
});

test('fem driver sends lamp functions and hands back at the end', async () => {
  const { link, sent } = recorder();
  const player = new Player({ driver: (show) => driverFor(show, link, { body: 0x40 }) });
  await player.play(quick);
  assert.deepEqual(sent, [
    '40: 10 03',
    '40: 2e d5 42 00 03 00 0c',
    '40: 2e d5 42 00 0c 00 0c',
    '40: 2e d5 42 00 00 00 00',
  ]);
});

test('fle driver scales levels to pwm per side', async () => {
  const { link, sent } = recorder();
  const show: Show = { ...quick, via: 'fle', steps: () => [{ levels: { fl_drl: 255, fr_drl: 128 }, holdMs: 1 }] };
  await new Player({ driver: (s) => driverFor(s, link, { left: 0x43, right: 0x44 }) }).play(show);
  assert.match(sent[2], /^43: 31 01 30 00 32 64 /);
  assert.match(sent[3], /^44: 31 01 30 00 32 32 /);
  assert.deepEqual(sent.slice(4), ['43: 31 02 30 00', '44: 31 02 30 00']);
});

test('a show refuses to start without its modules', async () => {
  const { link, sent } = recorder();
  const player = new Player({ driver: (show) => driverFor(show, link, { body: 0x40 }) });
  await assert.rejects(player.play(findShow('breathe')!), /FLE/);
  assert.deepEqual(sent, []);
});

test('lamps are released when a frame fails', async () => {
  const { link, sent } = recorder((_, uds) => uds[0] === 0x2e && uds[4] === 0x0c);
  const player = new Player({ driver: (show) => driverFor(show, link, { body: 0x40 }) });
  await assert.rejects(player.play(quick), /conditionsNotCorrect/);
  assert.equal(sent.at(-1), '40: 2e d5 42 00 00 00 00');
});

test('stop ends a looping show and waits for release', async () => {
  const events: string[] = [];
  const driver: Driver = {
    begin: async () => void events.push('begin'),
    frame: async () => void events.push('frame'),
    release: async () => {
      await new Promise((r) => setTimeout(r, 5));
      events.push('release');
    },
  };
  const player = new Player({ driver: () => driver });
  const playing = player.play({ ...quick, loop: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(player.playing, true);
  await player.stop();
  assert.equal(events.at(-1), 'release');
  assert.equal(player.playing, false);
  await playing;
});

test('starting a second show waits for the first to release', async () => {
  const events: string[] = [];
  const driver = (name: string): Driver => ({
    begin: async () => void events.push(`${name} begin`),
    frame: async () => {},
    release: async () => void events.push(`${name} release`),
  });
  const player = new Player({ driver: (show) => driver(show.id) });
  const first = player.play({ ...quick, id: 'a', loop: true });
  await new Promise((r) => setTimeout(r, 5));
  await player.play({ ...quick, id: 'b' });
  await first;
  assert.deepEqual(events, ['a begin', 'a release', 'b begin', 'b release']);
});

test('preview works with no car', async () => {
  const frames: Levels[] = [];
  await new Player({ onFrame: (l) => frames.push(l) }).play(quick);
  assert.equal(frames[1].fl_low, 255);
  assert.equal(frames[2].rl_brake, 255);
  assert.equal(frames.at(-1)!.rl_brake, 0);
});

test('parseShow rejects junk', () => {
  const ok = { id: 'mine', name: 'Mine', via: 'fem', loop: true, steps: [{ levels: { fl_drl: 255 }, holdMs: 100 }] };
  assert.equal(parseShow(ok).steps().length, 1);
  assert.throws(() => parseShow({ ...ok, via: 'rem' }), /via/);
  assert.throws(() => parseShow({ ...ok, steps: [{ levels: { horn: 255 }, holdMs: 100 }] }), /unknown output/);
  assert.throws(() => parseShow({ ...ok, steps: [{ levels: {}, holdMs: 1 }] }), /holdMs/);
  assert.throws(() => parseShow({ ...ok, steps: [] }), /steps/);
});
