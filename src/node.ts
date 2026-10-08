import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { Client, type ClientOptions } from './transport/client.ts';
import { doip, doipIdentRequest, hsfz, hsfzIdentRequest, HSFZ_IDENT_PORT, isIdentReply, type Framing } from './transport/framing.ts';
import type { ByteSocket } from './transport/socket.ts';

export class NodeSocket implements ByteSocket {
  private sock: net.Socket | null = null;
  private data: (chunk: Uint8Array) => void = () => {};
  private end: (err: Error) => void = () => {};

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port, noDelay: true });
      this.sock = sock;
      sock.once('connect', resolve);
      sock.once('error', reject);
      sock.on('data', (buf) => this.data(buf));
      sock.on('error', (err) => this.end(err));
      sock.on('close', () => this.end(new Error('socket closed')));
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new Error('socket not connected'));
      this.sock.write(bytes, (err) => (err ? reject(err) : resolve()));
    });
  }

  onData(fn: (chunk: Uint8Array) => void) {
    this.data = fn;
  }
  onEnd(fn: (err: Error) => void) {
    this.end = fn;
  }
  close() {
    this.sock?.destroy();
    this.sock = null;
  }
}

/**
 * Open a link to the car. F-series answer HSFZ on 6801, G-series DoIP on
 * 13400, and there is no cheap way to tell before trying, so we try both.
 */
export async function connect(host: string, opts: ClientOptions & { prefer?: Framing['name'] } = {}): Promise<Client> {
  const order = opts.framing ? [opts.framing] : opts.prefer === 'doip' ? [doip, hsfz] : [hsfz, doip];
  const errors: string[] = [];
  for (const framing of order) {
    const client = new Client(new NodeSocket(), { ...opts, framing });
    try {
      await client.connect(host);
      return client;
    } catch (e) {
      errors.push(`${framing.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(`no answer from ${host} (${errors.join(', ')})`);
}

/**
 * The broadcast address of every IPv4 interface, plus the global and link-local
 * ones. 255.255.255.255 leaves through one interface only, usually not the one
 * the car is on when the laptop also has Wi-Fi or a second adapter.
 */
export function broadcastAddresses(): string[] {
  const out = new Set(['255.255.255.255', '169.254.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const mask = a.netmask.split('.').map(Number);
      out.add(a.address.split('.').map((b, i) => Number(b) | (~mask[i] & 0xff)).join('.'));
    }
  }
  return [...out];
}

/**
 * Ask every network the machine is on for a BMW gateway and collect whoever
 * answers. Sends both the HSFZ identification (F-series, UDP 6811) and the
 * DoIP one (G-series, UDP 13400), so it works the same over a cable and over
 * an ENET Wi-Fi adapter without the user knowing an IP.
 */
export function discover(timeoutMs = 2500, broadcast = broadcastAddresses()): Promise<string[]> {
  return new Promise((resolve) => {
    const found = new Set<string>();
    const sock = dgram.createSocket('udp4');
    const timers: ReturnType<typeof setTimeout>[] = [];
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      timers.forEach(clearTimeout);
      sock.close();
      resolve([...found]);
    };

    sock.on('error', done);
    sock.on('message', (msg, from) => {
      if (isIdentReply(msg)) found.add(from.address);
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const requests: [Uint8Array, number][] = [
        [hsfzIdentRequest(), HSFZ_IDENT_PORT],
        [doipIdentRequest(), doip.port],
      ];
      const shout = () => {
        for (const addr of broadcast) for (const [req, port] of requests) sock.send(req, port, addr, () => {});
      };
      // single datagrams get lost on these adapters, repeat a few times
      shout();
      for (const at of [400, 1000, 1800]) if (at < timeoutMs) timers.push(setTimeout(shout, at));
      timers.push(setTimeout(done, timeoutMs));
    });
  });
}
