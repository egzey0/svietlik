#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fromHex, hex } from '../src/bytes.ts';
import { femLamp } from '../src/bmw/commands.ts';
import { guard, identify, readVoltage, send, type Module } from '../src/bmw/identify.ts';
import { LAMP } from '../src/bmw/tables.ts';
import { connect, discover } from '../src/node.ts';
import { driverFor } from '../src/show/drivers.ts';
import { Player } from '../src/show/player.ts';
import { SHOWS, findShow } from '../src/show/shows.ts';
import { describe, SID } from '../src/uds.ts';
import { HEIGHT, renderCar } from './render.ts';

// modules that did not answer "never heard of it" to a light command are worth a look
function lightHint(m: Module): string {
  const known = Object.entries(m.lights ?? {}).filter(([, reply]) => reply !== 'nrc 31' && reply !== 'nrc 11' && reply !== 'no answer');
  return known.length ? `<- knows ${known.map(([name]) => name).join(', ')}` : '';
}

const USAGE = `svietlik <command>

  find                         look for a car on the network (DoIP broadcast)
  scan <host> [--full] [--out file] [--keep-vin]
                               what is this car and can svietlik drive its lights.
                               Read-only, writes a report you can share
  shows                        list built in shows
  preview <show>               play a show in the terminal, no car needed
  play <host> <show>           play a show on the car
  lamp <host> <name> [ms]      light one lamp function (${Object.keys(LAMP).join(', ')})
  raw <host> <ecu> <hex>       send one UDS request, e.g. raw 192.168.16.1 40 "22 f1 90"
                               read services only unless --write is given

  --doip     try DoIP before HSFZ
  --trace    print every frame
  --speed n  playback speed, 0.25 to 4`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    full: { type: 'boolean' },
    'keep-vin': { type: 'boolean' },
    out: { type: 'string' },
    doip: { type: 'boolean' },
    trace: { type: 'boolean' },
    write: { type: 'boolean' },
    speed: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
const [command, ...args] = positionals;

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`missing ${what}\n\n${USAGE}`);
  return value;
}

const open = (host: string) =>
  connect(host, { prefer: flags.doip ? 'doip' : 'hsfz', trace: flags.trace ? (line) => console.error(line) : undefined });

function showOrExit(id: string) {
  const show = findShow(id);
  if (!show) throw new Error(`no show called ${id}, try: svietlik shows`);
  return show;
}

function makePlayer(opts: ConstructorParameters<typeof Player>[0]) {
  const player = new Player(opts);
  if (flags.speed) player.speed = Number(flags.speed) || 1;
  // ctrl+c has to go through stop() so the lamps are handed back
  process.once('SIGINT', () => void player.stop());
  return player;
}

const commands: Record<string, () => Promise<void>> = {
  async find() {
    const hosts = await discover();
    console.log(hosts.length ? hosts.join('\n') : 'nothing answered');
  },

  async scan() {
    const client = await open(need(args[0], 'host'));
    try {
      if (flags.full) console.log('walking every address, this takes a few minutes');
      const report = await identify(client, {
        full: flags.full,
        lights: true,
        keepVin: flags['keep-vin'],
        onModule: (m) => console.log(`  0x${m.address.toString(16).padStart(2, '0')}  ${(m.name ?? '?').padEnd(12)} ${lightHint(m)}`.trimEnd()),
      });
      console.log(`
vin       ${report.vin ?? 'not readable'}`);
      console.log(`transport ${report.framing}`);
      const { body, left, right } = report.profile;
      const volts = body !== undefined ? await readVoltage(client, body) : null;
      if (volts) console.log(`battery   ${volts.toFixed(1)} V`);
      console.log(`fem shows ${body !== undefined ? 'yes' : 'no, no FEM_20 found'}`);
      console.log(`fle shows ${left !== undefined && right !== undefined ? 'yes' : 'no, needs FLE02_L and FLE02_R'}`);

      const out = flags.out ?? `svietlik-report-${Date.now()}.json`;
      await writeFile(out, JSON.stringify(report, null, 2), { flag: 'wx' });
      console.log(`
wrote ${out}`);
      if (body === undefined || left === undefined) {
        console.log('This car is not mapped yet. The report is how it gets mapped:');
        console.log('https://github.com/egzey0/svietlik/issues/new?template=car-report.yml');
      }
    } finally {
      client.close();
    }
  },

  async shows() {
    for (const s of SHOWS) console.log(`${s.id.padEnd(14)} ${s.via}  ${s.loop ? 'loop' : 'once'}  ${s.name}`);
  },

  async preview() {
    const show = showOrExit(need(args[0], 'show'));
    let drawn = false;
    const player = makePlayer({
      onFrame(levels) {
        if (drawn) process.stdout.write(`\x1b[${HEIGHT}A`);
        process.stdout.write(renderCar(levels) + '\n');
        drawn = true;
      },
    });
    process.stdout.write('\x1b[?25l');
    try {
      await player.play(show);
    } finally {
      process.stdout.write('\x1b[?25h');
    }
  },

  async play() {
    const host = need(args[0], 'host');
    const show = showOrExit(need(args[1], 'show'));
    const client = await open(host);
    try {
      const { profile } = await identify(client);
      const link = guard(client, profile);
      const player = makePlayer({ driver: (s) => driverFor(s, link, profile) });
      console.log(`${show.name}${show.loop ? ', ctrl+c to stop' : ''}`);
      await player.play(show);
    } finally {
      client.close();
    }
  },

  async lamp() {
    const host = need(args[0], 'host');
    const name = need(args[1], 'lamp name') as keyof typeof LAMP;
    if (!(name in LAMP)) throw new Error(`unknown lamp ${name}`);
    const client = await open(host);
    try {
      const { profile } = await identify(client);
      if (profile.body === undefined) throw new Error('no FEM_20 on this car');
      await send(guard(client, profile), profile.body, femLamp(LAMP[name], Number(args[2]) || 1000));
    } finally {
      client.close();
    }
  },

  async raw() {
    const host = need(args[0], 'host');
    const ecu = parseInt(need(args[1], 'ecu address'), 16);
    const uds = fromHex(need(args.slice(2).join(' '), 'request bytes'));
    const readOnly: number[] = [SID.read, SID.readDtc, SID.testerPresent];
    if (!flags.write && !readOnly.includes(uds[0])) {
      throw new Error(`service 0x${uds[0].toString(16)} can change things on the car, pass --write if you mean it`);
    }
    const client = await open(host);
    try {
      const reply = await client.request(ecu, uds);
      console.log(reply.ok ? hex([reply.sid + 0x40, ...reply.data]) : `negative: ${describe(reply)}`);
    } finally {
      client.close();
    }
  },
};

const run = flags.help || !command ? null : commands[command];
if (!run) {
  console.log(USAGE);
  process.exit(command && !flags.help ? 1 : 0);
}
run().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
