import { hex, readU16 } from '../bytes.ts';
import type { UdsLink } from '../transport/client.ts';
import { describe, readDid, SID, testerPresent, type UdsReply } from '../uds.ts';
import { DID, ECU, FLE_ROUTINE } from './tables.ts';

export interface Module {
  address: number;
  name: string | null;
  hwNumber?: string;
  swVersion?: string;
}

/** Where the lighting modules of this particular car live. Missing key = not found. */
export interface Profile {
  body?: number;
  left?: number;
  right?: number;
  rear?: number;
}

export interface Report {
  createdAt: string;
  framing: string;
  vin: string | null;
  modules: Module[];
  profile: Profile;
}

const printable = (b: Uint8Array) => String.fromCharCode(...b.filter((c) => c >= 0x20 && c < 0x7f)).trim();

export function parseVin(data: Uint8Array): string {
  const vin = printable(data.subarray(2)).slice(-17);
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new Error('not a vin');
  return vin;
}

export async function readVin(link: UdsLink): Promise<string | null> {
  for (const ecu of [ECU.gateway, ECU.fem]) {
    try {
      const r = await link.request(ecu, readDid(DID.vin), 1000);
      if (r.ok) return parseVin(r.data);
    } catch {
      // try the next one
    }
  }
  return null;
}

/** Terminal 30 voltage as the FEM sees it. Worth checking before a long show. */
export async function readVoltage(link: UdsLink, ecu: number = ECU.fem): Promise<number | null> {
  try {
    const r = await link.request(ecu, readDid(DID.voltage), 1500);
    if (!r.ok || r.data.length < 4) return null;
    const volts = readU16(r.data, 2) / 10;
    return volts > 5 && volts < 18 ? volts : null;
  } catch {
    return null;
  }
}

export interface ScanOptions {
  /** walk 0x01..0xfe instead of the known lighting addresses, takes minutes */
  full?: boolean;
  signal?: AbortSignal;
  onModule?: (m: Module) => void;
}

/** Read-only. Pings addresses and reads identification DIDs, never writes. */
export async function scan(link: UdsLink, opts: ScanOptions = {}): Promise<Module[]> {
  const addresses = opts.full
    ? Array.from({ length: 0xfe }, (_, i) => i + 1)
    : [ECU.gateway, ECU.fem, ECU.fleLeft, ECU.fleRight, ECU.kombi, ECU.rem];
  const modules: Module[] = [];

  const read = async (address: number, did: number) => {
    try {
      const r = await link.request(address, readDid(did), 600);
      return r.ok ? r.data.subarray(2) : null;
    } catch {
      return null;
    }
  };

  for (const address of addresses) {
    opts.signal?.throwIfAborted();
    try {
      // any answer counts, a negative one still proves something lives here
      await link.request(address, testerPresent(false), 350);
    } catch {
      continue;
    }
    const name = await read(address, DID.ecuName);
    const hw = await read(address, DID.hwNumber);
    const sw = await read(address, DID.swVersion);
    const module: Module = {
      address,
      name: name ? printable(name) || null : null,
      hwNumber: hw ? hex(hw) : undefined,
      swVersion: sw ? hex(sw) : undefined,
    };
    modules.push(module);
    opts.onModule?.(module);
  }
  return modules;
}

/**
 * Light control is only mapped for FEM_20 / FLE02 / REM_20. Answering at 0x40
 * is not enough: a G-series BDC sits at the same address and speaks a
 * different command set, so we go by the name the module reports.
 */
export function resolveProfile(modules: Module[]): Profile {
  const find = (wanted: string) =>
    modules.find((m) => m.name?.toUpperCase().replace(/[ .-]/g, '_') === wanted)?.address;
  return {
    body: find('FEM_20'),
    left: find('FLE02_L'),
    right: find('FLE02_R'),
    rear: find('REM_20'),
  };
}

export async function identify(link: UdsLink & { framing?: { name: string } }, opts: ScanOptions = {}): Promise<Report> {
  const vin = await readVin(link);
  const modules = await scan(link, opts);
  return {
    createdAt: new Date().toISOString(),
    framing: link.framing?.name ?? 'unknown',
    vin,
    modules,
    profile: resolveProfile(modules),
  };
}

function allowed(profile: Profile, ecu: number, uds: Uint8Array): boolean {
  const sid = uds[0];
  if (sid === SID.read || sid === SID.testerPresent) return true;
  if (sid === SID.session) return uds[1] === 0x01 || uds[1] === 0x03;

  const did = readU16(uds, 1);
  if (ecu === profile.body) {
    return (sid === SID.write && did === DID.lampFunction) || (sid === SID.ioControl && did === DID.lampOutput);
  }
  if (ecu === profile.left || ecu === profile.right) {
    return sid === SID.routine && (uds[1] === 0x01 || uds[1] === 0x02) && readU16(uds, 2) === FLE_ROUTINE;
  }
  if (ecu === profile.rear) return sid === SID.write && did === DID.lampOutput;
  return false;
}

/**
 * Wraps a link so that only reads and the known light commands get through,
 * and only to modules the profile identified. Put user supplied effects and
 * anything experimental behind this.
 */
export function guard(link: UdsLink, profile: Profile): UdsLink {
  return {
    close: () => link.close(),
    request(ecu, uds, timeoutMs) {
      if (!allowed(profile, ecu, uds)) {
        const what = `${hex(uds.subarray(0, 4))} to 0x${ecu.toString(16)}`;
        return Promise.reject(new Error(`blocked: ${what} is not a known light command`));
      }
      return link.request(ecu, uds, timeoutMs);
    },
  };
}

/** Throws on a negative reply. */
export async function send(link: UdsLink, ecu: number, uds: Uint8Array, timeoutMs = 900): Promise<UdsReply> {
  const r = await link.request(ecu, uds, timeoutMs);
  if (!r.ok) throw new Error(`ecu 0x${ecu.toString(16)}: ${describe(r)}`);
  return r;
}
