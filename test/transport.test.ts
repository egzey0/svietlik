import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromHex, hex } from '../src/bytes.ts';
import { Client } from '../src/transport/client.ts';
import { doip, hsfz } from '../src/transport/framing.ts';
import { readDid, startRoutine, stopRoutine } from '../src/uds.ts';
import { FakeCar } from './fakeCar.ts';

test('hsfz wraps a request with tester and ecu address', () => {
  assert.equal(hex(hsfz.frame(hsfz.tester, 0x40, fromHex('22 f1 90'))), '00 00 00 05 00 01 f4 40 22 f1 90');
});

test('hsfz waits for the whole frame', () => {
  const frame = fromHex('00 00 00 05 00 01 40 f4 62 f1 90');
  assert.equal(hsfz.parse(frame.subarray(0, 8)), null);
  const parsed = hsfz.parse(frame);
  assert.deepEqual(parsed?.msg, { kind: 'uds', src: 0x40, dst: 0xf4, uds: fromHex('62 f1 90') });
  assert.equal(parsed?.size, 11);
});

test('hsfz reports gateway errors', () => {
  const parsed = hsfz.parse(fromHex('00 00 00 02 00 43 f4 99'));
  assert.deepEqual(parsed?.msg, { kind: 'error', message: 'hsfz: incorrect destination address' });
});

test('doip routing activation request', () => {
  assert.equal(hex(doip.hello()!), '02 fd 00 05 00 00 00 07 0e f8 00 00 00 00 00');
});

test('doip rejects garbage version bytes', () => {
  assert.throws(() => doip.parse(fromHex('02 02 80 01 00 00 00 00')), /bad version/);
});

test('doip routing response', () => {
  const ok = doip.parse(fromHex('02 fd 00 06 00 00 00 09 0e f8 00 10 10 00 00 00 00'));
  assert.equal(ok?.msg.kind, 'activated');
  const refused = doip.parse(fromHex('02 fd 00 06 00 00 00 09 0e f8 00 10 06 00 00 00 00'));
  assert.equal(refused?.msg.kind, 'error');
});

async function openClient(car: FakeCar, opts = {}) {
  const client = new Client(car, { keepAliveMs: 0, ...opts });
  await client.connect('car');
  return client;
}

test('request resolves with the parsed reply', async () => {
  const car = new FakeCar(() => [0x62, 0xf1, 0x90, 0x41, 0x42]);
  const client = await openClient(car);
  const r = await client.request(0x10, readDid(0xf190));
  assert.equal(r.ok, true);
  assert.equal(hex(r.data), 'f1 90 41 42');
  client.close();
});

test('negative response carries the nrc', async () => {
  const client = await openClient(new FakeCar(() => [0x7f, 0x22, 0x31]));
  const r = await client.request(0x40, readDid(0x1234));
  assert.deepEqual([r.ok, r.nrc], [false, 0x31]);
  client.close();
});

test('responsePending keeps the request alive', async () => {
  const car = new FakeCar(() => [[0x7f, 0x22, 0x78], [0x62, 0xf1, 0x90]]);
  const client = await openClient(car);
  assert.equal((await client.request(0x10, readDid(0xf190))).ok, true);
  client.close();
});

test('replies from another ecu or for another did are ignored', async () => {
  const car = new FakeCar(() => null);
  const client = await openClient(car);
  const pending = client.request(0x40, readDid(0xf190), 200);
  car.push(car.reply(0x43, [0x62, 0xf1, 0x90]));
  car.push(car.reply(0x40, [0x62, 0xf1, 0x91]));
  car.push(car.reply(0x40, [0x62, 0xf1, 0x90, 0x01]));
  assert.equal(hex((await pending).data), 'f1 90 01');
  client.close();
});

test('a timed out ecu is not retried on the same connection', async () => {
  const client = await openClient(new FakeCar(() => null));
  await assert.rejects(client.request(0x55, readDid(0xf190), 20), /timeout/);
  await assert.rejects(client.request(0x55, readDid(0xf190), 20), /reconnect/);
  client.close();
});

test('a timed out start does not block the stop that cleans up after it', async () => {
  const car = new FakeCar((_, uds) => (uds[1] === 0x01 ? null : [0x71, 0x02, 0x30, 0x00]));
  const client = await openClient(car);
  await assert.rejects(client.request(0x43, startRoutine(0x3000, [1, 2]), 20), /timeout/);
  await assert.rejects(client.request(0x43, startRoutine(0x3000, [3, 4]), 20), /reconnect/);
  assert.equal((await client.request(0x43, stopRoutine(0x3000))).ok, true);
  client.close();
});

test('requests run one at a time, in order', async () => {
  const car = new FakeCar((_, uds) => [0x62, uds[1], uds[2]]);
  const client = await openClient(car);
  await Promise.all([1, 2, 3].map((n) => client.request(0x40, readDid(n))));
  assert.deepEqual(car.sent, ['40: 22 00 01', '40: 22 00 02', '40: 22 00 03']);
  client.close();
});

test('everything queued rejects when the socket drops', async () => {
  const car = new FakeCar(() => null);
  let dropped = false;
  const client = await openClient(car, { onDrop: () => (dropped = true) });
  const a = client.request(0x40, readDid(1));
  const b = client.request(0x40, readDid(2));
  car.hangUp();
  await assert.rejects(a, /socket closed/);
  await assert.rejects(b, /socket closed/);
  await assert.rejects(client.request(0x40, readDid(3)), /not connected/);
  assert.equal(dropped, true);
});
