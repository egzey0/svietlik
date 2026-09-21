// Everything here is runtime agnostic (no node imports), so it bundles for
// React Native and the browser. The node socket and discovery live in ./node.

export * from './bytes.ts';
export * from './uds.ts';
export { Client, type ClientOptions, type UdsLink } from './transport/client.ts';
export { doip, hsfz, type Framing, type Incoming } from './transport/framing.ts';
export type { ByteSocket } from './transport/socket.ts';

export * from './bmw/tables.ts';
export * from './bmw/commands.ts';
export * from './bmw/identify.ts';

export * from './show/patterns.ts';
export { SHOWS, findShow, parseShow, type Show } from './show/shows.ts';
export { driverFor, femDriver, fleDriver, type Driver } from './show/drivers.ts';
export { Player, type PlayerOptions } from './show/player.ts';
