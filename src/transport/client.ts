import { concat, hex } from '../bytes.ts';
import { answers, isPending, parseReply, signature, testerPresent, type UdsReply } from '../uds.ts';
import { hsfz, type Framing, type Incoming } from './framing.ts';
import type { ByteSocket } from './socket.ts';

/** Anything that can carry a UDS request to an ECU. Drivers depend on this, not on Client. */
export interface UdsLink {
  request(ecu: number, uds: Uint8Array, timeoutMs?: number): Promise<UdsReply>;
  close(): void;
}

export interface ClientOptions {
  framing?: Framing;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  /** TesterPresent interval, 0 to disable */
  keepAliveMs?: number;
  /** ceiling for a request that keeps answering 0x78 responsePending */
  maxPendingMs?: number;
  maxQueue?: number;
  trace?: (line: string) => void;
  onDrop?: (err: Error) => void;
}

interface Job {
  ecu: number;
  uds: Uint8Array;
  timeoutMs: number;
  giveUpAt: number;
  resolve: (r: UdsReply) => void;
  reject: (e: Error) => void;
}

/**
 * One request on the wire at a time, the rest wait in a queue. A client is
 * single use: once it drops, every queued promise rejects and you make a new one.
 */
export class Client implements UdsLink {
  readonly framing: Framing;
  private rx: Uint8Array = new Uint8Array(0);
  private queue: Job[] = [];
  private current: Job | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private activation: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private state: 'new' | 'open' | 'dead' = 'new';
  // Requests that timed out. The reply may still be in flight and would look
  // exactly like the answer to a retry, so the same request is refused until
  // reconnect. Keyed on what a reply echoes, so a timed out "start routine"
  // does not block the "stop routine" that cleans up after it.
  private stale = new Set<string>();
  private readonly socket: ByteSocket;
  private readonly opts: ClientOptions;

  constructor(socket: ByteSocket, opts: ClientOptions = {}) {
    this.socket = socket;
    this.opts = opts;
    this.framing = opts.framing ?? hsfz;
    socket.onData((chunk) => this.receive(chunk));
    socket.onEnd((err) => this.drop(err));
  }

  get open(): boolean {
    return this.state === 'open';
  }

  private get dead(): boolean {
    return this.state === 'dead';
  }

  async connect(host: string): Promise<void> {
    if (this.state !== 'new') throw new Error('client already used, create a new one');
    const limit = this.opts.connectTimeoutMs ?? 4000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`connect timeout (${host}:${this.framing.port})`)), limit);
    });

    try {
      await Promise.race([this.socket.connect(host, this.framing.port), timeout]);
      const hello = this.framing.hello();
      if (hello) {
        const activated = new Promise<void>((resolve, reject) => (this.activation = { resolve, reject }));
        await this.socket.write(hello);
        await Promise.race([activated, timeout]);
      }
    } catch (e) {
      this.drop(e as Error, false);
      throw e;
    } finally {
      clearTimeout(timer);
      this.activation = null;
    }
    if (this.dead) throw new Error('connection closed during connect');
    this.state = 'open';

    const every = this.opts.keepAliveMs ?? 2000;
    if (every > 0) {
      this.keepAlive = setInterval(() => {
        if (this.current) return;
        this.send(this.framing.frame(this.framing.tester, 0x10, testerPresent()));
      }, every);
    }
  }

  request(ecu: number, uds: Uint8Array, timeoutMs = this.opts.timeoutMs ?? 5000): Promise<UdsReply> {
    if (this.state !== 'open') return Promise.reject(new Error('not connected'));
    if (!Number.isInteger(ecu) || ecu < 0 || ecu > this.framing.maxEcu) return Promise.reject(new Error(`bad ecu address ${ecu}`));
    if (!uds.length || !(timeoutMs > 0)) return Promise.reject(new Error('bad request'));
    if (this.queue.length >= (this.opts.maxQueue ?? 64)) return Promise.reject(new Error('request queue full'));

    return new Promise((resolve, reject) => {
      this.queue.push({ ecu, uds: uds.slice(), timeoutMs, giveUpAt: 0, resolve, reject });
      this.next();
    });
  }

  close(): void {
    this.drop(new Error('closed'), false);
  }

  private next(): void {
    if (this.current || this.state !== 'open') return;
    const job = this.queue.shift();
    if (!job) return;

    if (this.stale.has(`${job.ecu}:${signature(job.uds)}`)) {
      job.reject(new Error(`ecu 0x${job.ecu.toString(16)} timed out on this request earlier, reconnect before retrying`));
      queueMicrotask(() => this.next());
      return;
    }
    this.current = job;
    job.giveUpAt = Date.now() + (this.opts.maxPendingMs ?? 30000);
    this.arm(job);
    this.opts.trace?.(`> ${job.ecu.toString(16)} ${hex(job.uds)}`);
    this.send(this.framing.frame(this.framing.tester, job.ecu, job.uds));
  }

  private arm(job: Job): void {
    if (this.timer) clearTimeout(this.timer);
    const ms = Math.max(0, Math.min(job.timeoutMs, job.giveUpAt - Date.now()));
    this.timer = setTimeout(() => {
      this.stale.add(`${job.ecu}:${signature(job.uds)}`);
      this.finish(() => job.reject(new Error(`timeout waiting for ecu 0x${job.ecu.toString(16)}`)));
    }, ms);
  }

  private finish(settle: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    settle();
    queueMicrotask(() => this.next());
  }

  private send(bytes: Uint8Array): void {
    this.socket.write(bytes).catch((e) => this.drop(e));
  }

  private receive(chunk: Uint8Array): void {
    if (this.dead) return;
    this.rx = concat(this.rx, chunk);
    try {
      for (;;) {
        const parsed = this.framing.parse(this.rx);
        if (!parsed) return;
        this.rx = this.rx.subarray(parsed.size);
        this.handle(parsed.msg);
        if (this.dead) return;
      }
    } catch (e) {
      this.drop(e as Error);
    }
  }

  private handle(msg: Incoming): void {
    switch (msg.kind) {
      case 'activated':
        this.activation?.resolve();
        return;
      case 'alive': {
        const reply = this.framing.aliveReply();
        if (reply) this.send(reply);
        return;
      }
      case 'error':
        if (this.activation) this.activation.reject(new Error(msg.message));
        this.drop(new Error(msg.message));
        return;
      case 'ignore':
        return;
    }

    this.opts.trace?.(`< ${msg.src.toString(16)} ${hex(msg.uds)}`);
    const job = this.current;
    if (!job || msg.src !== job.ecu || msg.dst !== this.framing.tester || !answers(job.uds, msg.uds)) return;
    if (isPending(msg.uds)) return this.arm(job);
    const reply = parseReply(msg.uds.slice());
    this.finish(() => job.resolve(reply));
  }

  private drop(err: Error, notify = true): void {
    if (this.dead) return;
    const wasOpen = this.state === 'open';
    this.state = 'dead';
    if (this.timer) clearTimeout(this.timer);
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.activation?.reject(err);
    this.current?.reject(err);
    this.current = null;
    for (const job of this.queue.splice(0)) job.reject(err);
    this.socket.close();
    if (notify && wasOpen) this.opts.onDrop?.(err);
  }
}
