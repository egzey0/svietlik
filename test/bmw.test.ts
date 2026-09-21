import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hex } from '../src/bytes.ts';
import { femLamp, femOutput, femOutputRelease, fleLeds, fleStop, remOutput } from '../src/bmw/commands.ts';
import { guard, identify, maskVin, parseVin, resolveProfile } from '../src/bmw/identify.ts';
import { FEM_OUTPUT, LAMP, REM_OUTPUT } from '../src/bmw/tables.ts';
import { Client } from '../src/transport/client.ts';
import { readDid, session, writeDid } from '../src/uds.ts';
import { FakeCar } from './fakeCar.ts';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

test('command bytes', () => {
  assert.equal(hex(femLamp(LAMP.lowBeam, 200)), '2e d5 42 00 03 00 14');
  assert.equal(hex(femOutput(FEM_OUTPUT.all, false)), '2f 45 01 03 fe 00');
  assert.equal(hex(femOutputRelease(FEM_OUTPUT.all)), '2f 45 01 00 fe');
  assert.equal(hex(remOutput(REM_OUTPUT.plate, true)), '2e 45 01 22 01');
  assert.equal(hex(fleStop()), '31 02 30 00');
});

test('fle clamps pwm and current', () => {
  const bytes = fleLeds(250, 0xff);
  assert.equal(bytes.length, 4 + 20);
  assert.deepEqual([...bytes.subarray(4, 8)], [0x32, 100, 0x32, 100]);
  const perChannel = fleLeds([10, 20]);
  assert.deepEqual([...perChannel.subarray(4, 10)], [0x32, 10, 0x32, 20, 0x32, 0]);
});

test('lamp time saturates instead of wrapping', () => {
  assert.equal(hex(femLamp(1, 10_000_000).subarray(5)), 'ff ff');
});

test('vin', () => {
  assert.equal(parseVin(Uint8Array.from([0xf1, 0x90, ...ascii('WBA00000000000042')])), 'WBA00000000000042');
  assert.throws(() => parseVin(Uint8Array.from([0xf1, 0x90, ...ascii('SHORT')])));
});

test('profile goes by module name, not by address', () => {
  const profile = resolveProfile([
    { address: 0x40, name: 'BDC_BODY' },
    { address: 0x51, name: 'fle02-l' },
    { address: 0x52, name: 'FLE02_R' },
  ]);
  assert.deepEqual(profile, { body: undefined, left: 0x51, right: 0x52, rear: undefined });
});

function f82() {
  const names: Record<number, string> = { 0x10: 'ZGW_01', 0x40: 'FEM_20', 0x43: 'FLE02_L', 0x44: 'FLE02_R', 0x72: 'REM_20' };
  return new FakeCar((ecu, uds) => {
    if (!(ecu in names)) return null;
    if (uds[0] === 0x3e) return [0x7e, 0x00];
    if (uds[0] !== 0x22) return [0x7f, uds[0], 0x11];
    if (uds[1] === 0xf1 && uds[2] === 0x90) return [0x62, 0xf1, 0x90, ...ascii('WBA00000000000042')];
    if (uds[1] === 0xf1 && uds[2] === 0x97) return [0x62, 0xf1, 0x97, ...ascii(names[ecu])];
    return [0x7f, 0x22, 0x31];
  });
}

test('identify only reads', async () => {
  const car = f82();
  const client = new Client(car, { keepAliveMs: 0 });
  await client.connect('car');
  const report = await identify(client);
  client.close();

  assert.equal(report.vin, 'WBA00000000******');
  assert.equal(report.framing, 'hsfz');
  assert.deepEqual(report.profile, { body: 0x40, left: 0x43, right: 0x44, rear: 0x72 });
  assert.deepEqual(
    report.modules.map((m) => m.name),
    ['ZGW_01', 'FEM_20', 'FLE02_L', 'FLE02_R', 'REM_20'],
  );
  const services = new Set(car.sent.map((line) => line.split(' ')[1]));
  assert.deepEqual([...services].sort(), ['22', '3e']);
});

test('an unmapped car still produces a useful report', async () => {
  // G-series shaped: a BDC at 0x40 that knows neither light DID, nothing at the FLE addresses
  const car = new FakeCar((ecu, uds) => {
    if (ecu !== 0x10 && ecu !== 0x40) return null;
    if (uds[0] === 0x3e) return [0x7e, 0x00];
    if (uds[0] === 0x31) return [0x7f, 0x31, 0x31];
    if (uds[1] === 0xf1 && uds[2] === 0x97) return [0x62, 0xf1, 0x97, ...ascii(ecu === 0x40 ? 'BDC_BODY' : 'ZGW_02')];
    if (uds[1] === 0xf1 && uds[2] === 0x50) return [0x62, 0xf1, 0x50, 0x0f, 0x2b, 0x40];
    return [0x7f, 0x22, 0x31];
  });
  const client = new Client(car, { keepAliveMs: 0 });
  await client.connect('car');
  const report = await identify(client, { lights: true, keepVin: true });
  client.close();

  assert.equal(report.vin, null);
  assert.deepEqual(report.profile, { body: undefined, left: undefined, right: undefined, rear: undefined });
  const bdc = report.modules.find((m) => m.address === 0x40)!;
  assert.equal(bdc.name, 'BDC_BODY');
  assert.equal(bdc.ids!.f150, '0f 2b 40');
  assert.deepEqual(bdc.lights, { lampFunction: 'nrc 31', lampOutput: 'nrc 31', ledRoutine: 'nrc 31' });
  // probing asks, it never writes or starts anything
  for (const line of car.sent) assert.match(line, /: (22|3e|31 03) /);
});

test('masked vin keeps the model and hides the serial', () => {
  assert.equal(maskVin('WBA00000000000042'), 'WBA00000000******');
});

test('guard lets known light commands through and nothing else', async () => {
  const seen: string[] = [];
  const link = guard(
    {
      close() {},
      async request(ecu, uds) {
        seen.push(`${ecu.toString(16)}: ${hex(uds)}`);
        return { ok: true, sid: uds[0], data: new Uint8Array(0) };
      },
    },
    { body: 0x40, left: 0x43, right: 0x44 },
  );

  await link.request(0x40, femLamp(LAMP.drl, 100));
  await link.request(0x43, fleLeds(50));
  await link.request(0x60, readDid(0xf190));
  await link.request(0x40, session(0x03));

  await assert.rejects(link.request(0x40, session(0x02)), /blocked/);
  await assert.rejects(link.request(0x40, writeDid(0x1234, [1])), /blocked/);
  await assert.rejects(link.request(0x60, femLamp(LAMP.drl, 100)), /blocked/);
  await assert.rejects(link.request(0x72, remOutput(REM_OUTPUT.plate, false)), /blocked/);
  await assert.rejects(link.request(0x40, Uint8Array.of(0x11, 0x01)), /blocked/);
  assert.equal(seen.length, 4);
});
