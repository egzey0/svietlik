<p align="center">
  <picture>
    <source srcset="docs/logo-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="docs/logo-light.svg" media="(prefers-color-scheme: light)">
    <img src="docs/logo-light.svg" alt="svietlik" width="420">
  </picture>
</p>
<p align="center">Talk to the light modules of a BMW over an ENET cable, from TypeScript.</p>

---

svietlik is a small library and CLI. It speaks HSFZ and DoIP to the car's
gateway, sends UDS requests to the modules behind it, and knows the handful of
commands that make an F-series BMW light its lamps on request. On top of that
sits a player that turns a list of timed steps into a light show.

No runtime dependencies. The core has no Node imports, so it bundles for React
Native; you bring the TCP socket.

## Scan your car, no coding

The scan tells you whether svietlik can drive your car's lights, and if not,
produces the report that gets the car added. It only reads: module names, part
numbers, and whether each module recognises the light commands. Nothing is
switched on and nothing on the car changes.

1. Download the app for your computer:
   [Windows](https://github.com/egzey0/svietlik/releases/latest/download/svietlik-windows-x64.exe) ·
   [Mac, Apple silicon](https://github.com/egzey0/svietlik/releases/latest/download/svietlik-mac-apple-silicon.zip) ·
   [Mac, Intel](https://github.com/egzey0/svietlik/releases/latest/download/svietlik-mac-intel.zip) ·
   [Linux](https://github.com/egzey0/svietlik/releases/latest/download/svietlik-linux-x64.tar.gz)
2. Ignition on, the engine can stay off. Connect the car (see below).
3. Double click the app. It waits for the car, scans it, saves the report next
   to itself and opens the report form with the report filled in. Posting it
   needs a free GitHub account.

The app is not signed, so the first start asks for a click more. Windows:
"More info", then "Run anyway". Mac: double click once, then System Settings,
Privacy & Security, "Open Anyway".

### Cable or Wi-Fi

Anything that puts the car's ENET (ethernet over the OBD port) on your
network works:

- **ENET cable**, OBD on one end and RJ45 on the other, into the computer's
  network port or a USB ethernet dongle. No setup, the car and the computer
  agree on a `169.254.x.x` address by themselves. Windows takes up to a minute
  to do that.
- **ENET Wi-Fi adapter**, the kind sold for coding F and G series with
  E-Sys and similar tools. Connect the computer to the adapter's own network. The
  computer usually loses internet while it is connected, the app tells you
  when to switch back.

Plain OBD2 adapters (ELM327, OBDLink, vLinker, K+DCAN cables) do not work.
They speak a serial protocol the car's gateway does not use for this.

The app finds the car on its own on either: it asks every network the computer
is on, with both the F-series identification request (HSFZ, UDP 6811) and the
G-series one (DoIP, UDP 13400).

### What the scan says

```
  0x10  ZGW_01
  0x40  FEM_20
  0x43  FLE02_L
  0x44  FLE02_R
  0x72  REM_20

vin       WBS00000000******
transport hsfz
battery   12.4 V
fem shows yes
fle shows yes
```

"yes" means the car has the modules svietlik has commands for. If it says no,
the report is the useful part: it lists what the car has instead. The serial
half of the VIN is masked in the file. A module that reacts to one of the
light commands with anything other than "never heard of it" gets a
`<- knows ...` note next to its name, which is the first thing to look for on
an unmapped car.

| Car | State |
| --- | --- |
| F-series with FEM_20, FLE02 LED headlights, REM_20 (tested on an F82 M4 LCI) | Everything in this repo |
| Other F-series reporting the same module names | Should work, the commands are per module and not per model. Reports wanted |
| F-series with halogen or xenon headlights | `fem` shows only, there is no FLE to dim. Reports wanted |
| G-series (BDC instead of FEM) | Connects over DoIP, scan works. No light commands, the BDC map is not known yet |
| E-series | Nothing, different protocol (K-line / D-CAN) |

[cars/](cars/README.md) keeps the list of what has been seen so far and what
is wanted most. A module is driven only if it reports the expected name: a BDC
answers at the same address as a FEM, so the address alone proves nothing.

## Developers

Node 22.6 or newer.

```sh
npx svietlik scan                 # finds the car and scans it
npm install svietlik              # the library
```

From source:

```sh
git clone https://github.com/egzey0/svietlik
cd svietlik
npm install
npm run build && npm link     # puts `svietlik` on your PATH
```

Without building, `node cli/svietlik.ts <command>` runs straight from source.

## CLI

```
svietlik start                      the guided scan the downloaded app runs
svietlik find                       look for a car on the network, cable or Wi-Fi
svietlik scan [host] [--full]       what is this car, can its lights be driven. Read-only
svietlik send <report.json>         open the car report form with the report filled in
svietlik shows                      list built in shows
svietlik preview <show>             play a show in the terminal, no car needed
svietlik play <host> <show>         play it on the car, ctrl+c hands the lamps back
svietlik lamp <host> lowBeam 500    one lamp function for 500 ms
svietlik raw <host> 40 "22 f1 90"   one UDS request, reads only unless --write
```

`--trace` prints every request and reply. `scan` always writes a report file,
`--out` names it, `--keep-vin` leaves the VIN unmasked. Without a host it uses
the first car `find` sees. `--full` walks all 254 addresses instead of the
known six and takes a few minutes; use it on anything that is not an F3x/F8x.

## Library

```ts
import { guard, identify, driverFor, findShow, Player } from 'svietlik';
import { connect } from 'svietlik/node';

const car = await connect('169.254.92.38');     // tries HSFZ, then DoIP
const { profile } = await identify(car);        // read-only
const link = guard(car, profile);               // from here on only light commands pass

const player = new Player({ driver: (show) => driverFor(show, link, profile) });
await player.play(findShow('welcome')!);
car.close();
```

Lower down, everything is a function from arguments to bytes:

```ts
import { femLamp, fleLeds, LAMP } from 'svietlik';

await car.request(0x40, femLamp(LAMP.highBeam, 300));   // 2e d5 42 00 05 00 1e
await car.request(0x43, fleLeds(35));                   // left headlight at 35 %
```

Your own show is a list of steps. Levels are 0 to 255, outputs you leave out
keep their level.

```ts
const mine = {
  id: 'mine', name: 'Mine', loop: true, via: 'fle',
  steps: () => [
    { levels: { fl_drl: 255, fr_drl: 0 }, holdMs: 200 },
    { levels: { fl_drl: 0, fr_drl: 255 }, holdMs: 200 },
  ],
};
```

`via: 'fem'` goes through the FEM's lamp functions: on/off only, but it reaches
every lamp including the rear. `via: 'fle'` drives the LED headlight modules
with PWM, so it can fade, front only. `parseShow()` validates one that came
from JSON.

### React Native

`svietlik` (without `/node`) imports nothing from Node. Implement `ByteSocket`
(five methods, see `src/transport/socket.ts`) over `react-native-tcp-socket`
and hand it to `new Client(socket, { framing: hsfz })`. Expo Go has no raw TCP,
you need a development build.

## Safety

This forces lamp outputs through the same diagnostic services a workshop
tester uses. It does not code, flash or write anything permanent. The FEM
lamp function expires by itself after the time you gave it, and the headlight
routine is stopped explicitly at the end of a show. Still:

- Parked only. You are overriding exterior lighting.
- `Player.stop()` and ctrl+c in the CLI restore the lamps and tell you if a
  module did not confirm. Pulling the cable mid show skips that, and you are
  then relying on the modules dropping out of the diagnostic session on their
  own. If a headlight stays in a strange state, cycle the ignition.
- The REM (rear) output write in `commands.ts` is not used by the built in
  shows. It has no "return control" and does not reliably clear on a session
  change, see PROTOCOL.md before you build on it.
- LED shows draw current with the engine off. `scan` prints battery voltage.
- `guard()` rejects everything that is not a read or one of the known light
  commands, and only lets those reach modules that identified themselves.
  Keep user supplied input behind it.

MIT licensed, no warranty. It is your car.

## Protocol notes

[PROTOCOL.md](PROTOCOL.md) has the byte level: framing, addresses, the three
light commands, the negative responses you hit when you get them wrong, and
where the information comes from.

## Adding a car

Run the [app](#scan-your-car-no-coding), or `svietlik scan --full` followed by
`svietlik send <report.json>`, and post the
[car report](https://github.com/egzey0/svietlik/issues/new?template=car-report.yml)
it opens. For G-series the missing piece is the BDC's lamp
control job; if you have worked it out, PROTOCOL.md is the place.

## Development

```sh
npm test            # runs the .ts files directly, against an in-memory gateway
npm run typecheck
node brand/build.mjs   # regenerates the logo from brand/*.txt
npm run app            # the single file app for this machine, in build/
```

Pushing a `v*` tag builds the apps for Windows, both Macs and Linux and
attaches them to a GitHub release.
