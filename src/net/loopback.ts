import * as net from 'node:net';

const LOOPBACK = ['127.0.0.1', '::1'];

export function probeLoopbackPort(port: number, timeoutMs = 500): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return Promise.all(LOOPBACK.map((host) => probe(host, port, timeoutMs))).then((r) => r.some(Boolean));
}

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
