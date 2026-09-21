# Cars

What is known per car. A row gets here through a
[car report](https://github.com/egzey0/svietlik/issues/new?template=car-report.yml);
the scan that produces one is read-only and takes about a minute.

| Car | Headlights | Body / light modules | fem shows | fle shows | Source |
| --- | --- | --- | --- | --- | --- |
| F82 M4 LCI | LED | FEM_20, FLE02_L, FLE02_R, REM_20 | yes | yes | author's car |

Wanted most:

- any G-series (G20, G30, G05, G80...). The body controller is a BDC and
  nobody has written down its lamp commands yet. A `--full` report shows which
  modules exist and how they react to the F-series commands.
- F-series with halogen or xenon headlights, to confirm the FEM path without
  an FLE.
- other cars with a FEM (F20, F22, F30, F32 and their siblings), LCI or not.
- the older F-series with an FRM instead of a FEM (F01, F10, F25). Probably
  different commands, the report will tell.

## Reading a report

```json
{
  "address": 64,
  "name": "FEM_20",
  "ids": { "f197": "...", "f150": "...", "f191": "...", "f189": "..." },
  "lights": { "lampFunction": "...", "lampOutput": "...", "ledRoutine": "nrc 31" }
}
```

`ids` are plain identification reads: name, SGBD index (which ECU description
file the module belongs to), hardware number, software version.

`lights` is how the module answered when asked about the three commands
svietlik knows, without running them: a read of DID `d542`, a read of DID
`4501`, and a results query for routine `3000`. `nrc 31` means "never heard of
it", `nrc 11` means the module does not do that service at all. Anything else,
including other error codes, means the module recognised the identifier and is
a candidate. It is a hint and not proof: a DID can be write-only and still
answer `31` to a read.
