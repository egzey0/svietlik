import { u16 } from '../bytes.ts';
import { Io, ioControl, startRoutine, stopRoutine, writeDid } from '../uds.ts';
import { DID, FLE_CHANNELS, FLE_ROUTINE } from './tables.ts';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

/**
 * FEM: light a lamp function for `ms`, then the FEM lets go on its own.
 *   2E D5 42 <lamp:2> <time:2>    time in 10 ms ticks
 * Both fields are two bytes. Shorter variants come back as NRC 0x13.
 */
export function femLamp(lamp: number, ms: number): Uint8Array {
  return writeDid(DID.lampFunction, [...u16(lamp), ...u16(clamp(ms / 10, 0, 0xffff))]);
}

/**
 * FEM: force one output and hold it. Plain UDS IO control:
 *   2F 45 01 03 <output> <00|01>
 * Holds only while the diagnostic session is alive.
 */
export function femOutput(output: number, on: boolean): Uint8Array {
  return ioControl(DID.lampOutput, Io.shortTermAdjust, [output, on ? 1 : 0]);
}

export function femOutputRelease(output: number): Uint8Array {
  return ioControl(DID.lampOutput, Io.returnControl, [output]);
}

/**
 * REM: same DID as the FEM but a plain write, and no way to hand control back:
 *   2E 45 01 <output> <00|01>
 * To restore, write the output back on and drop to the default session.
 */
export function remOutput(output: number, on: boolean): Uint8Array {
  return writeDid(DID.lampOutput, [output, on ? 1 : 0]);
}

// The FLE answers requestOutOfRange for anything above this.
export const FLE_MAX_CURRENT = 0x32;

/**
 * FLE: drive the led channels of one headlight.
 *   31 01 30 00 (<current> <pwm>) x10    pwm 0..100
 * Takes one pwm for the whole headlight or one per channel.
 */
export function fleLeds(pwm: number | number[], current = FLE_MAX_CURRENT): Uint8Array {
  const cur = clamp(current, 0, FLE_MAX_CURRENT);
  const data: number[] = [];
  for (let ch = 0; ch < FLE_CHANNELS; ch++) {
    const value = Array.isArray(pwm) ? (pwm[ch] ?? 0) : pwm;
    data.push(cur, clamp(value, 0, 100));
  }
  return startRoutine(FLE_ROUTINE, data);
}

export const fleStop = () => stopRoutine(FLE_ROUTINE);
