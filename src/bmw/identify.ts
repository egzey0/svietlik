import { hex, readU16, u16 } from '../bytes.ts';
import type { UdsLink } from '../transport/client.ts';
import { describe, readDid, SID, testerPresent, type UdsReply } from '../uds.ts';
import { DID, ECU, FLE_ROUTINE } from './tables.ts';

export interface Module {
  address: number;
  name: string | null;
  /** raw identification reads, DID in hex to reply bytes or "nrc xx" */
  ids?: Record<string, string>;
  /** how the module reacted to being asked about the light commands, see probeLights */
  lights?: Record<string, string>;
}

/** Where the lighting modules of this particular car live. Missing key = not found. */
export interface Profile {
  body?: number;
  left?: number;
  right?: number;
  rear?: number;
}

export interface Report {
  schema: 1;
  createdAt: string;
  framing: string;
  /** serial number masked unless asked otherwise */
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

/**
 * Keeps manufacturer, model code, year and plant, hides the serial. Enough to
 * tell which car a report is about without pointing at one particular car.
 */
export const maskVin = (vin: string) => vin.slice(0, 11) + '******';

export interface ScanOptions {
  /** walk 0x01..0xfe instead of the known lighting addresses, takes minutes */
  full?: boolean;
  /** also ask every module whether it knows the light commands (still read-only) */
  lights?: boolean;
  /** put the full VIN in the report */
  keepVin?: boolean;
  signal?: AbortSignal;
  onModule?: (m: Module) => void;
}

const IDENT_DIDS = [DID.ecuName, DID.sgbdIndex, DID.hwNumber, DID.swVersion];

async function ask(link: UdsLink, address: number, uds: Uint8Array, skip = 0): Promise<{ text: string; data: Uint8Array | null }> {
  try {
    const r = await link.request(address, uds, 600);
    if (!r.ok) return { text: `nrc ${(r.nrc ?? 0).toString(16).padStart(2, '0')}`, data: null };
    return { text: hex(r.data.subarray(skip)), data: r.data.subarray(skip) };
  } catch {
    return { text: 'no answer', data: null };
  }
}

/**
 * Asks a module about the three light commands without running any of them:
 * a read of the two DIDs and a "routine results" query for the FLE routine.
 * A module that has never heard of them answers requestOutOfRange (nrc 31),
 * anything else is worth a closer look. Treat it as a hint, some DIDs are
 * write-only and answer 31 to a read even though the write works.
 */
export async function probeLights(link: UdsLink, address: number): Promise<Record<string, string>> {
  return {
    lampFunction: (await ask(link, address, readDid(DID.lampFunction), 2)).text,
    lampOutput: (await ask(link, address, readDid(DID.lampOutput), 2)).text,
    ledRoutine: (await ask(link, address, Uint8Array.of(SID.routine, 0x03, ...u16(FLE_ROUTINE)), 3)).text,
  };
}

/** Read-only. Pings addresses and reads identification DIDs, never writes or starts anything. */
export async function scan(link: UdsLink, opts: ScanOptions = {}): Promise<Module[]> {
  const addresses = opts.full
    ? Array.from({ length: 0xfe }, (_, i) => i + 1)
    : [ECU.gateway, ECU.fem, ECU.fleLeft, ECU.fleRight, ECU.kombi, ECU.rem];
  const modules: Module[] = [];

  for (const address of addresses) {
    opts.signal?.throwIfAborted();
    try {
      // any answer counts, a negative one still proves something lives here
      await link.request(address, testerPresent(false), 350);
    } catch {
      continue;
    }
    const module: Module = { address, name: null, ids: {} };
    for (const did of IDENT_DIDS) {
      const { text, data } = await ask(link, address, readDid(did), 2);
      module.ids![did.toString(16)] = text;
      if (did === DID.ecuName && data) module.name = printable(data) || null;
    }
    if (opts.lights) module.lights = await probeLights(link, address);
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
    schema: 1,
    createdAt: new Date().toISOString(),
    framing: link.framing?.name ?? 'unknown',
    vin: vin && !opts.keepVin ? maskVin(vin) : vin,
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
