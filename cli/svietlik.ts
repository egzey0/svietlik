#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isSea } from 'node:sea';
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
import { copyText, openUrl, REPORT_FORM, reportUrl } from './share.ts';

// modules that did not answer "never heard of it" to a light command are worth a look
function lightHint(m: Module): string {
  const known = Object.entries(m.lights ?? {}).filter(([, reply]) => reply !== 'nrc 31' && reply !== 'nrc 11' && reply !== 'no answer');
  return known.length ? `<- knows ${known.map(([name]) => name).join(', ')}` : '';
}

const USAGE = `svietlik <command>

  start                        guided scan: waits for the car, scans it and opens
                               the report form. What the downloaded app runs
  find                         look for a car on the network, cable or Wi-Fi
  scan [host] [--full] [--out file] [--keep-vin]
                               what is this car and can svietlik drive its lights.
                               Read-only, writes a report you can share. Without a
                               host it uses the first car find sees
  send <report.json>           open the car report form with this report filled in
  shows                        list built in shows
  preview <show>               play a show in the terminal, no car needed
  play <host> <show>           play a show on the car
  lamp <host> <name> [ms]      light one lamp function (${Object.keys(LAMP).join(', ')})
  raw <host> <ecu> <hex>       send one UDS request, e.g. raw 192.168.16.1 40 "22 f1 90"
                               read services only unless --write is given

  --doip     try DoIP before HSFZ
  --trace    print every frame
  --speed n  playback speed, 0.25 to 4`;

const NOT_FOUND = `Check that:
  - the ignition is on (the engine can stay off)
  - with a cable: it is in the OBD port and in this computer's network port.
    Windows can take up to a minute to give the cable an address
  - with Wi-Fi: this computer is connected to the adapter's own network
  - the adapter is ENET. ELM327, OBDLink and K+DCAN adapters do not speak it`;

const INTRO = `svietlik scan

Finds out which light modules your BMW has. It only reads, nothing on the car
changes. Takes about a minute.

  1. Ignition on, the engine can stay off.
  2. Either an ENET cable from the OBD port to this computer's network port,
     or this computer connected to your ENET Wi-Fi adapter's network.
`;

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

// a double clicked download has no arguments and a console window that closes
// the moment we exit
const guided = isSea() && process.argv.length <= 2;
const [command, ...args] = guided ? ['start'] : positionals;

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`missing ${what}\n\n${USAGE}`);
  return value;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question).finally(() => rl.close());
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

const reportName = () => `svietlik-report-${Date.now()}.json`;

// next to the downloaded app, where people look for it. Double clicking on a
// Mac starts in the home folder
const reportDir = () => (isSea() ? dirname(process.execPath) : process.cwd());

async function findOne(): Promise<string> {
  const hosts = await discover();
  if (!hosts.length) throw new Error(`no car found on the network\n\n${NOT_FOUND}`);
  if (hosts.length > 1) console.log(`several gateways answered (${hosts.join(', ')}), using ${hosts[0]}`);
  return hosts[0];
}

async function waitForCar(): Promise<string> {
  process.stdout.write('looking for the car (ctrl+c to quit) ');
  const started = Date.now();
  let hinted = false;
  for (;;) {
    const [host] = await discover();
    if (host) {
      process.stdout.write('\n');
      return host;
    }
    process.stdout.write('.');
    if (!hinted && Date.now() - started > 20_000) {
      hinted = true;
      process.stdout.write(`\n\nstill nothing. ${NOT_FOUND}\n\nstill looking `);
    }
  }
}

async function scanCar(host: string, out: string) {
  const client = await open(host);
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

    const json = JSON.stringify(report, null, 2);
    await writeFile(out, json, { flag: 'wx' });
    console.log(`
wrote ${out}`);
    return { json, file: out, supported: body !== undefined };
  } finally {
    client.close();
  }
}

async function share(json: string, car?: string) {
  const { url, withReport } = reportUrl(json, car);
  const copied = await copyText(json);
  const opened = await openUrl(url);
  console.log(opened ? '\nThe report form is open in your browser.' : `\nOpen this in a browser:\n${url}`);
  if (withReport) console.log('The report is already filled in. Pick the headlight type and press Create.');
  else if (copied) console.log('The report is in your clipboard, paste it into the Report box.');
  else console.log('Paste the contents of the report file into the Report box.');
  console.log(`Posting needs a free GitHub account. The form: ${REPORT_FORM}`);
}

const commands: Record<string, () => Promise<void>> = {
  async start() {
    console.log(INTRO);
    const host = await waitForCar();
    console.log(`found a car at ${host}\n`);
    const scanned = await scanCar(host, join(reportDir(), reportName()));
    console.log(
      scanned.supported
        ? '\nsvietlik can drive the lights on this car. Sending the report still helps, it puts the car on the list.'
        : '\nThis car is not mapped yet. Your report is what is needed to add it.',
    );
    if (!process.stdin.isTTY) return;

    const car = (await ask('\nWhich car is it? Chassis, model, year, e.g. "F30 330i 2016 LCI": ')).trim();
    await ask('If the Wi-Fi adapter took your internet, switch back to your normal network now.\nPress Enter to open the report form...');
    await share(scanned.json, car || undefined);
  },

  async find() {
    const hosts = await discover();
    console.log(hosts.length ? hosts.join('\n') : `nothing answered\n\n${NOT_FOUND}`);
  },

  async scan() {
    const scanned = await scanCar(args[0] ?? (await findOne()), flags.out ?? reportName());
    if (!scanned.supported) {
      console.log('This car is not mapped yet. The report is how it gets mapped:');
      console.log(`svietlik send ${scanned.file}`);
    }
  },

  async send() {
    await share(await readFile(need(args[0], 'report file'), 'utf8'));
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
run()
  .catch((e: Error) => {
    console.error(`\n${e.message}`);
    process.exitCode = 1;
  })
  .then(async () => {
    if (guided && process.stdin.isTTY) await ask('\nPress Enter to close');
    process.exit();
  });
