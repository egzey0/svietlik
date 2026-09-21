import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { concat } from '../src/bytes.ts';
import { readVin } from '../src/bmw/identify.ts';
import { connect } from '../src/node.ts';
import { hsfz } from '../src/transport/framing.ts';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

// a gateway on localhost that answers the VIN, one byte at a time to exercise reassembly
function gateway(): Promise<net.Server> {
  const server = net.createServer((sock) => {
    let rx: Uint8Array = new Uint8Array(0);
    sock.on('data', (chunk) => {
      rx = concat(rx, chunk);
      for (let parsed = hsfz.parse(rx); parsed; parsed = hsfz.parse(rx)) {
        rx = rx.subarray(parsed.size);
        if (parsed.msg.kind !== 'uds' || parsed.msg.uds[0] !== 0x22) continue;
        const reply = { ...hsfz, tester: parsed.msg.dst }.wrap(hsfz.tester, Uint8Array.from([0x62, 0xf1, 0x90, ...ascii('WBA00000000000042')]));
        for (const byte of reply) sock.write(Uint8Array.of(byte));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('reads the vin over a real socket', async () => {
  const server = await gateway();
  const port = (server.address() as net.AddressInfo).port;
  const client = await connect('127.0.0.1', { framing: { ...hsfz, port }, keepAliveMs: 0 });
  try {
    assert.equal(await readVin(client), 'WBA00000000000042');
  } finally {
    client.close();
    server.close();
  }
});

test('connect reports every transport it tried', async () => {
  await assert.rejects(connect('127.0.0.1', { framing: { ...hsfz, port: 1 }, connectTimeoutMs: 500 }), /no answer from 127.0.0.1 \(hsfz: /);
});
