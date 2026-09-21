export const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
export const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

export const readU16 = (b: Uint8Array, at = 0) => (b[at] << 8) | b[at + 1];
export const readU32 = (b: Uint8Array, at = 0) => b[at] * 0x1000000 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);

export function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/[\s,]|0x/gi, '');
  if (!clean || clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error(`bad hex: ${s}`);
  return Uint8Array.from(clean.match(/../g)!, (p) => parseInt(p, 16));
}
