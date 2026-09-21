/**
 * The only thing the client needs from a TCP socket. node.ts has the node:net
 * one; on React Native wrap react-native-tcp-socket the same way.
 */
export interface ByteSocket {
  connect(host: string, port: number): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  onData(fn: (chunk: Uint8Array) => void): void;
  /** called once, on error or remote close */
  onEnd(fn: (err: Error) => void): void;
  close(): void;
}
