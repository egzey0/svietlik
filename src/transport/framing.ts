import { concat, hex, readU16, readU32, u16, u32 } from '../bytes.ts';

/**
 * What a decoded wire message means to the client. Everything protocol
 * specific stays in this file; the client only reacts to these.
 */
export type Incoming =
  | { kind: 'uds'; src: number; dst: number; uds: Uint8Array }
  | { kind: 'activated' }
  | { kind: 'alive' }
  | { kind: 'ignore' }
  | { kind: 'error'; message: string };

export interface Framing {
  name: 'hsfz' | 'doip';
  port: number;
  tester: number;
  maxEcu: number;
  /** sent right after TCP connect, null if the protocol has no handshake */
  hello(): Uint8Array | null;
  aliveReply(): Uint8Array | null;
  frame(src: number, dst: number, uds: Uint8Array): Uint8Array;
  /** one message off the front of buf, or null when more bytes are needed */
  parse(buf: Uint8Array): { msg: Incoming; size: number } | null;
}

const MAX_FRAME = 1 << 20;

// HSFZ, BMW's own framing on F-series. TCP 6801.
//   length(4) type(2) | src(1) dst(1) uds...
// length counts everything after the type field.
const HSFZ_ERRORS: Record<number, string> = {
  0x40: 'incorrect tester address',
  0x41: 'incorrect control word',
  0x42: 'incorrect format',
  0x43: 'incorrect destination address',
  0x44: 'message too large',
  0x45: 'diagnostic application not ready',
  0xff: 'out of memory',
};

export const hsfz: Framing = {
  name: 'hsfz',
  port: 6801,
  tester: 0xf4,
  maxEcu: 0xff,
  hello: () => null,
  aliveReply: () => null,
  frame(src, dst, uds) {
    return concat(u32(uds.length + 2), u16(0x01), [src, dst], uds);
  },
  parse(buf) {
    if (buf.length < 6) return null;
    const len = readU32(buf, 0);
    if (len > MAX_FRAME) throw new Error('hsfz: frame too large');
    const size = 6 + len;
    if (buf.length < size) return null;
    const type = readU16(buf, 4);
    const body = buf.subarray(6, size);

    if (type === 0x01) {
      if (body.length < 3) throw new Error('hsfz: truncated diagnostic frame');
      return { msg: { kind: 'uds', src: body[0], dst: body[1], uds: body.subarray(2) }, size };
    }
    if (type in HSFZ_ERRORS) return { msg: { kind: 'error', message: `hsfz: ${HSFZ_ERRORS[type]}` }, size };
    // 0x02 is the gateway echoing our request back as an ack, 0x12 an alive check
    return { msg: { kind: 'ignore' }, size };
  },
};

// DoIP, ISO 13400-2. TCP 13400. G-series and newer.
//   version(1) ~version(1) type(2) length(4) | payload
const DOIP = {
  nack: 0x0000,
  identRequest: 0x0001,
  routingRequest: 0x0005,
  routingResponse: 0x0006,
  aliveRequest: 0x0007,
  aliveResponse: 0x0008,
  diag: 0x8001,
  diagAck: 0x8002,
  diagNack: 0x8003,
} as const;

function doipMessage(type: number, payload: ArrayLike<number>): Uint8Array {
  return concat([0x02, 0xfd], u16(type), u32(payload.length), payload);
}

export const doipIdentRequest = () => doipMessage(DOIP.identRequest, []);

export const doip: Framing = {
  name: 'doip',
  port: 13400,
  tester: 0x0ef8,
  maxEcu: 0xffff,
  hello() {
    // source address, activation type 0 (default), 4 reserved bytes
    return doipMessage(DOIP.routingRequest, [...u16(this.tester), 0x00, 0, 0, 0, 0]);
  },
  aliveReply() {
    return doipMessage(DOIP.aliveResponse, u16(this.tester));
  },
  frame(src, dst, uds) {
    return doipMessage(DOIP.diag, concat(u16(src), u16(dst), uds));
  },
  parse(buf) {
    if (buf.length < 8) return null;
    if ((buf[0] ^ 0xff) !== buf[1]) throw new Error(`doip: bad version bytes ${hex(buf.subarray(0, 2))}`);
    const len = readU32(buf, 4);
    if (len > MAX_FRAME) throw new Error('doip: frame too large');
    const size = 8 + len;
    if (buf.length < size) return null;
    const type = readU16(buf, 2);
    const body = buf.subarray(8, size);

    switch (type) {
      case DOIP.diag:
        if (body.length < 5) throw new Error('doip: truncated diagnostic frame');
        return { msg: { kind: 'uds', src: readU16(body, 0), dst: readU16(body, 2), uds: body.subarray(4) }, size };
      case DOIP.routingResponse:
        if (body.length < 5 || readU16(body, 0) !== this.tester) return { msg: { kind: 'ignore' }, size };
        if (body[4] === 0x10) return { msg: { kind: 'activated' }, size };
        return { msg: { kind: 'error', message: `doip: routing activation refused (0x${body[4].toString(16)})` }, size };
      case DOIP.aliveRequest:
        return { msg: { kind: 'alive' }, size };
      case DOIP.nack:
      case DOIP.diagNack:
        return { msg: { kind: 'error', message: `doip: nack ${hex(body)}` }, size };
      default:
        return { msg: { kind: 'ignore' }, size };
    }
  },
};
