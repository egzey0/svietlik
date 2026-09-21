import { hex } from '../src/bytes.ts';
import { hsfz, type Framing } from '../src/transport/framing.ts';
import type { ByteSocket } from '../src/transport/socket.ts';

type Responder = (ecu: number, uds: Uint8Array) => number[] | number[][] | null;

/**
 * In-memory gateway. Decodes what the client writes and answers through
 * `respond`; return null to stay silent (dead address).
 */
export class FakeCar implements ByteSocket {
  sent: string[] = [];
  private data: (chunk: Uint8Array) => void = () => {};
  private end: (err: Error) => void = () => {};

  private respond: Responder;
  private framing: Framing;

  constructor(respond: Responder, framing: Framing = hsfz) {
    this.respond = respond;
    this.framing = framing;
  }

  async connect() {}
  onData(fn: (chunk: Uint8Array) => void) {
    this.data = fn;
  }
  onEnd(fn: (err: Error) => void) {
    this.end = fn;
  }
  close() {}

  async write(bytes: Uint8Array) {
    const parsed = this.framing.parse(bytes);
    if (!parsed || parsed.msg.kind !== 'uds') return;
    const { dst: ecu, uds } = parsed.msg;
    if (uds[0] === 0x3e && uds[1] === 0x80) return;
    this.sent.push(`${ecu.toString(16)}: ${hex(uds)}`);
    const out = this.respond(ecu, uds);
    if (!out) return;
    const replies = (Array.isArray(out[0]) ? out : [out]) as number[][];
    for (const r of replies) queueMicrotask(() => this.push(this.reply(ecu, r)));
  }

  /** frame a reply the way the gateway would */
  reply(ecu: number, uds: number[]): Uint8Array {
    const f = this.framing;
    const swapped = { ...f, tester: ecu, wrap: f.wrap };
    return swapped.wrap(f.tester, Uint8Array.from(uds));
  }

  push(bytes: Uint8Array) {
    this.data(bytes);
  }
  hangUp() {
    this.end(new Error('socket closed'));
  }
}
