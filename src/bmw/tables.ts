// Addresses and element tables for the F-series lighting modules (FEM_20,
// FLE02, REM_20). Element names follow the ECU description files.

export const ECU = {
  gateway: 0x10,
  fem: 0x40,
  fleLeft: 0x43,
  fleRight: 0x44,
  kombi: 0x60,
  rem: 0x72,
} as const;

export const DID = {
  vin: 0xf190,
  ecuName: 0xf197,
  hwNumber: 0xf191,
  swVersion: 0xf189,
  /** BMW specific: which ECU description file (SGBD) the module belongs to */
  sgbdIndex: 0xf150,
  voltage: 0xdad6,
  /** FEM LEUCHTEN_FUNKTION: light a lamp function for a given time */
  lampFunction: 0xd542,
  /** FEM and REM STEUERN_LEUCHTENAUSGANG_DIGITAL: force a single output */
  lampOutput: 0x4501,
} as const;

/** FLE routine _LEUCHTEN_AUSSENLICHT_KANAL: current + pwm for each of the 10 led channels */
export const FLE_ROUTINE = 0x3000;
export const FLE_CHANNELS = 10;

/** lamp functions for DID.lampFunction (TAB_LAMPEN_FUNKTION) */
export const LAMP = {
  position: 0x01,
  lowBeam: 0x03,
  drl: 0x04,
  highBeam: 0x05,
  turnLeft: 0x06,
  turnRight: 0x07,
  fogFront: 0x08,
  cornerLeft: 0x09,
  cornerRight: 0x0a,
  brake: 0x0c,
  fogRear: 0x0e,
  reverse: 0x0f,
  parkLeft: 0x10,
  parkRight: 0x11,
  hazards: 0x12,
  interior: 0x13,
} as const;

/** FEM outputs for DID.lampOutput (TAB_AUSGANG_LEUCHTEN) */
export const FEM_OUTPUT = {
  lowLeft: 0x01,
  lowRight: 0x02,
  drlLeft: 0x03,
  drlRight: 0x04,
  sideLeft: 0x05,
  sideRight: 0x06,
  highLeft: 0x07,
  highRight: 0x08,
  parkLeft: 0x09,
  parkRight: 0x0a,
  fogLeft: 0x0b,
  fogRight: 0x0c,
  bixenonLeft: 0x12,
  bixenonRight: 0x13,
  ringLeft: 0x30,
  ringRight: 0x31,
  all: 0xfe,
} as const;

/** REM outputs for DID.lampOutput (LAMPEN_AUSGANG) */
export const REM_OUTPUT = {
  tailLeft: 0x14,
  tailRight: 0x15,
  tail2Left: 0x16,
  tail2Right: 0x17,
  brakeLeft: 0x18,
  brakeRight: 0x19,
  brakeForceLeft: 0x1a,
  brakeForceRight: 0x1b,
  fogLeft: 0x1c,
  fogRight: 0x1d,
  reverseLeft: 0x1e,
  reverseRight: 0x1f,
  turnLeft: 0x20,
  turnRight: 0x21,
  plate: 0x22,
  brakeCenter: 0x23,
} as const;
