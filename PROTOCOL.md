# Protocol notes

What goes over the wire, in the order you need it. Everything marked
"on the car" was checked against an F82 M4 LCI; the rest comes from the sources
at the bottom.

## Getting to the gateway

The OBD port of an F or G series BMW has Ethernet on it. An ENET cable is a
passive adapter, the Wi-Fi dongles are a small access point in front of the
same thing. Behind it sits the central gateway (ZGW), which routes diagnostic
requests to every other module by a one byte address.

Two framings exist. Try HSFZ first on F-series and DoIP first on G-series.

### HSFZ, TCP 6801

```
00 00 00 05   00 01   f4 40   22 f1 90
length        type    src dst uds
```

`length` counts everything after the type field. Type `0001` is a diagnostic
message, `0002` is the gateway echoing your request back as an acknowledgement
(ignore it, the real answer follows as another `0001`), `0012` is an alive
check. `0040` to `0045` are errors: wrong tester address, wrong control word,
wrong format, unknown destination, message too large, not ready.

The tester address is `f4`. There is no handshake, you can send the first
request as soon as the socket is open.

### DoIP, TCP 13400 (ISO 13400-2)

```
02 fd   80 01   00 00 00 07   0e f8   00 40   22 f1 90
version type    length        src     dst     uds
```

Before the first diagnostic message you have to activate routing:

```
-> 02 fd 00 05 00 00 00 07   0e f8 00 00 00 00 00
<- 02 fd 00 06 00 00 00 09   0e f8 00 10 10 00 00 00 00
                                         ^^ 0x10 = accepted
```

`8002` is a positive acknowledgement of your message (ignore), `8003` a
negative one, `0007` an alive check that wants a `0008` back with your address.
A UDP broadcast of `02 fd 00 01 00 00 00 00` to port 13400 makes every DoIP
entity on the link announce itself, which is how `svietlik find` works.

### Keeping the session

Forced outputs only hold while a non-default diagnostic session is alive, and
the session dies a few seconds after the last request. Send `3e 80` (tester
present, no reply wanted) every two seconds when idle.

The gateway multiplexes all modules over one socket and replies can arrive
late. Match a reply on source address, service and the echoed DID or routine
id, not only on the service. After a timeout do not retry the same module and
service on the same connection: you cannot tell a late first answer from the
second one.

## Modules

| Address | Name | Role |
| --- | --- | --- |
| `10` | ZGW_01 | gateway |
| `40` | FEM_20 | front electronic module, master for exterior lights |
| `43` | FLE02_L | left LED headlight |
| `44` | FLE02_R | right LED headlight |
| `60` | KOMBI | instrument cluster |
| `72` | REM_20 | rear electronic module |

All but the KOMBI confirmed on the car. Read `22 f1 97` from a module to get its name as ASCII
(after the two DID bytes); `f1 90` is the VIN, `f1 91` the hardware number,
`f1 89` the software version. `22 da d6` on the FEM returns terminal 30
voltage, two bytes, in 0.1 V.

On G-series the body controller is a BDC. It answers at `40` too and its
command set is different, so identify by name before you write anything.

## Light commands

### FEM: lamp function for a time

```
-> 40   2e d5 42   00 03   00 14        low beam for 200 ms
<- 40   6e d5 42
```

Write to DID `d542` (job `LEUCHTEN_FUNKTION`). Two bytes of lamp, two bytes of
time in 10 ms ticks. Both are required and both are two bytes; leaving the time
out or sending a one byte lamp gives NRC `13`. The FEM turns the lamp off by
itself when the time is up, so a show re-sends the command each step with a
time slightly longer than the step.

Lamps: `01` position, `03` low beam, `04` DRL, `05` high beam, `06` turn left,
`07` turn right, `08` front fog, `09`/`0a` cornering left/right, `0c` brake,
`0e` rear fog, `0f` reverse, `10`/`11` parking left/right, `12` hazards,
`13` interior.

This is a function, not an output: `05` lights both high beams, `06` the whole
left side of indicators front and rear. It can turn lamps on but not off.

### FEM: single output, on or off, held

```
-> 40   2f 45 01   03   fe   00         all outputs off
<- 40   6f 45 01   03
-> 40   2f 45 01   00   fe              hand them back
```

DID `4501` (job `STEUERN_LEUCHTENAUSGANG_DIGITAL`) with ordinary UDS IO
control: `03` short term adjustment, then output and state; `00` returns
control. The description file lists action values `40` and `80`, which the car
does not want. Without the control parameter byte you get NRC `13`.

Outputs: `01`/`02` low beam L/R, `03`/`04` DRL, `05`/`06` side, `07`/`08` high
beam, `09`/`0a` position, `0b`/`0c` fog, `12`/`13` bi-xenon shutter, `30`/`31`
rings, `fe` all.

On a car with LED headlights the front lamps are driven by the FLE modules and
forcing them here is accepted but changes nothing you can see. On the test car
"all off" only took out the interior and footwell lights.

### FLE: LED channels with PWM

```
-> 43   31 01 30 00   32 64  32 64  32 64  ... (10 pairs)
<- 43   71 01 30 00
-> 43   31 02 30 00                     stop, back to normal
```

Routine `3000` (`_LEUCHTEN_AUSSENLICHT_KANAL`). Ten pairs of current and PWM,
one per LED channel. PWM is 0 to 100. A current of `32` is accepted, `ff` is
refused with NRC `31`; the real ceiling is somewhere in between and svietlik
stays at `32`. Which channel is which LED group (DRL, low, high, ring) is not
mapped yet; svietlik sets all ten to the same value.

### REM: rear outputs

```
-> 72   2e 45 01   22   00              plate light off
<- 72   6e 45 01
```

Same DID as on the FEM but a plain write (`2e`), no control parameter. Outputs:
`14`/`15` tail L/R, `16`/`17` second tail, `18`/`19` brake, `1a`/`1b` brake
force display, `1c`/`1d` rear fog, `1e`/`1f` reverse, `20`/`21` turn, `22`
plate, `23` centre brake.

There is no return-control for this one, and a forced-off output does not
reliably come back when the session ends. Write it back on (`... 22 01`) and
then send `10 01`. For that reason the built in shows stay away from the REM
and reach the rear through FEM lamp functions.

## Finding out what a module knows without touching anything

Useful on a car nobody has mapped. For each module that answers:

```
22 f1 97        name
22 f1 50        SGBD index, tells you which ECU description file applies
22 d5 42        does it know the lamp function DID
22 45 01        does it know the lamp output DID
31 03 30 00     routine results for 3000, does it know the LED routine
```

None of these change state. NRC `31` means the identifier is unknown to the
module, `11` that it does not implement the service. Any other answer,
positive or not, means the identifier exists there. `svietlik scan` does
exactly this and writes the raw answers to the report.

## Negative responses you will meet

| NRC | Meaning here |
| --- | --- |
| `11` | the module does not know the service, usually wrong module |
| `13` | wrong length: missing time field, missing control parameter, one byte where two are expected |
| `22` | conditions not correct, the module refuses in its current state |
| `31` | value out of range: FLE current too high, unknown lamp or output |
| `78` | response pending, keep waiting, the real answer follows |
| `7e` / `7f` | not available in this session, send `10 03` first |

## Where this comes from

- ISO 14229-1 (UDS) and ISO 13400-2 (DoIP)
- [EdiabasLib](https://github.com/uholeschak/ediabaslib), the open
  implementation of BMW's diagnostic runtime, for HSFZ and the tester address
- [ediabasx](https://github.com/emdzej/ediabasx), a TypeScript port, used
  offline to read job and table names out of ECU description files
- [dissecto HSFZ and DoIP notes](https://munich.dissec.to/kb/chapters/doip/doip.html)
- The ECU description files (`*.prg`) that ship with BMW's own tools name the
  jobs, DIDs and tables. They are BMW's and are not in this repo. Byte widths
  and the control parameter were settled on the car, by sending variants and
  reading the NRC.
