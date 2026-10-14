import * as net from 'node:net';

export class BlackholeProxy {
  private server: net.Server | undefined;
  readonly attempts: string[] = [];

  async start(): Promise<number> {
    this.server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        const line = chunk.toString('latin1').split('\r\n')[0] ?? '';
        const target = /^(?:CONNECT|GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH)\s+(\S+)/.exec(line)?.[1];
        if (target && this.attempts.length < 200) this.attempts.push(target);
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      });
      socket.on('error', () => undefined);
      socket.setTimeout(5000, () => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    return (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }
}
