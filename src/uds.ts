import { concat, hex, u16 } from './bytes.ts';

export const SID = {
  session: 0x10,
  readDtc: 0x19,
  read: 0x22,
  write: 0x2e,
  ioControl: 0x2f,
  routine: 0x31,
  testerPresent: 0x3e,
} as const;

export const Session = { default: 0x01, extended: 0x03 } as const;

// 0x2F control parameter
export const Io = { returnControl: 0x00, shortTermAdjust: 0x03 } as const;

export const NRC: Record<number, string> = {
  0x10: 'generalReject',
  0x11: 'serviceNotSupported',
  0x12: 'subFunctionNotSupported',
  0x13: 'incorrectMessageLengthOrInvalidFormat',
  0x14: 'responseTooLong',
  0x21: 'busyRepeatRequest',
  0x22: 'conditionsNotCorrect',
  0x24: 'requestSequenceError',
  0x31: 'requestOutOfRange',
  0x33: 'securityAccessDenied',
  0x35: 'invalidKey',
  0x36: 'exceedNumberOfAttempts',
  0x37: 'requiredTimeDelayNotExpired',
  0x72: 'generalProgrammingFailure',
  0x78: 'responsePending',
  0x7e: 'subFunctionNotSupportedInActiveSession',
  0x7f: 'serviceNotSupportedInActiveSession',
};

export const session = (s: number) => Uint8Array.of(SID.session, s);
export const testerPresent = (quiet = true) => Uint8Array.of(SID.testerPresent, quiet ? 0x80 : 0x00);
export const readDid = (did: number) => Uint8Array.of(SID.read, ...u16(did));
export const writeDid = (did: number, data: ArrayLike<number>) => concat([SID.write, ...u16(did)], data);
export const ioControl = (did: number, param: number, data: ArrayLike<number> = []) =>
  concat([SID.ioControl, ...u16(did), param], data);
export const startRoutine = (id: number, data: ArrayLike<number> = []) => concat([SID.routine, 0x01, ...u16(id)], data);
export const stopRoutine = (id: number) => Uint8Array.of(SID.routine, 0x02, ...u16(id));

export interface UdsReply {
  ok: boolean;
  sid: number;
  /** everything after the response SID */
  data: Uint8Array;
  nrc?: number;
}

export function parseReply(raw: Uint8Array): UdsReply {
  if (raw[0] === 0x7f) return { ok: false, sid: raw[1], data: raw.subarray(3), nrc: raw[2] };
  return { ok: true, sid: raw[0] - 0x40, data: raw.subarray(1) };
}

export const isPending = (raw: Uint8Array) => raw[0] === 0x7f && raw[2] === 0x78;

export function describe(r: UdsReply): string {
  if (r.ok) return 'ok';
  return NRC[r.nrc ?? -1] ?? `nrc 0x${(r.nrc ?? 0).toString(16)}`;
}

// How many bytes after the SID a positive reply echoes back.
function echoLength(sid: number): number {
  if (sid === SID.read || sid === SID.write || sid === SID.ioControl) return 2;
  if (sid === SID.routine) return 3;
  if (sid === SID.session || sid === SID.testerPresent || sid === SID.readDtc) return 1;
  return 0;
}

/** The part of a request a positive reply echoes. Two requests with the same signature have indistinguishable answers. */
export const signature = (req: Uint8Array) => hex(req.subarray(0, 1 + echoLength(req[0])));

/**
 * Is `res` the answer to `req`? The gateway multiplexes several ECUs over one
 * socket and a late reply to an earlier request looks a lot like a fresh one,
 * so we compare the echoed DID / routine id and not only the SID.
 */
export function answers(req: Uint8Array, res: Uint8Array): boolean {
  if (!req.length || !res.length) return false;
  if (res[0] === 0x7f) return res.length >= 3 && res[1] === req[0];
  if (res[0] !== req[0] + 0x40) return false;
  const n = echoLength(req[0]);
  if (req.length <= n || res.length <= n) return false;
  for (let i = 1; i <= n; i++) {
    // sub-function byte comes back without the suppress-response bit
    const sent = i === 1 && n !== 2 ? req[i] & 0x7f : req[i];
    if (res[i] !== sent) return false;
  }
  return true;
}
