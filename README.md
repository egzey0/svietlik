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

```
$ svietlik scan 169.254.92.38
  0x10  ZGW_01
  0x40  FEM_20
  0x43  FLE02_L
  0x44  FLE02_R
  0x72  REM_20
vin       WBS...
transport hsfz
battery   12.4 V
lighting  fem 0x40, fle 0x43/0x44, rem 0x72

$ svietlik play 169.254.92.38 welcome
```

## What works on which car

| Car | State |
| --- | --- |
| F-series with FEM_20, FLE02 LED headlights, REM_20 (tested on an F82 M4 LCI) | Everything in this repo |
| Other F-series reporting the same module names | Should work, the commands are per module and not per model. Not tested |
| F-series with halogen or xenon headlights | `fem` shows only, there is no FLE to dim |
| G-series (BDC instead of FEM) | Connects over DoIP, reads VIN and module names. No light commands, the BDC map is not known yet |
| E-series | Nothing, different protocol (K-line / D-CAN) |

A module is driven only if it reports the expected name. A BDC answers at the
same address as a FEM, so the address alone proves nothing.

## Install

Not on npm yet. Node 22.6 or newer.

```sh
git clone https://github.com/egzey0/svietlik
cd svietlik
npm install
npm run build && npm link     # puts `svietlik` on your PATH
```

Without building, `node cli/svietlik.ts <command>` runs straight from source.

You need an ENET cable or an ENET Wi-Fi adapter in the OBD port, and your
machine on the same network as the adapter. `svietlik find` broadcasts a DoIP
identification request and prints whoever answers. If nothing does, the usual
addresses are `169.254.x.x` for a cable and whatever the adapter's DHCP hands
out for Wi-Fi (the gateway is normally the adapter's own IP).

## CLI

```
svietlik find                       look for a car on the network
svietlik scan <host> [--full]       VIN, module names, battery. Read-only
svietlik shows                      list built in shows
svietlik preview <show>             play a show in the terminal, no car needed
svietlik play <host> <show>         play it on the car, ctrl+c hands the lamps back
svietlik lamp <host> lowBeam 500    one lamp function for 500 ms
svietlik raw <host> 40 "22 f1 90"   one UDS request, reads only unless --write
```

`--trace` prints every request and reply. `--out report.json` on `scan` saves
the result; the file contains your VIN, look before you share it.

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

Run `svietlik scan <host> --full --out report.json` and open an issue with the
module list (strip the VIN). For G-series the missing piece is the BDC's lamp
control job; if you have worked it out, PROTOCOL.md is the place.

## Development

```sh
npm test            # runs the .ts files directly, against an in-memory gateway
npm run typecheck
node brand/build.mjs   # regenerates the logo from brand/*.txt
```
