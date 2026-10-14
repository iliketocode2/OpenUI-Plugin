import { isIP } from 'node:net';

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const kind = isIP(host);
  if (kind === 4) return PRIVATE_V4.some((re) => re.test(host));
  if (kind === 6) {
    if (host === '::' || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    const mapped = dotted ?? (hex ? [parseInt(hex[1]!, 16) >> 8, parseInt(hex[1]!, 16) & 255, parseInt(hex[2]!, 16) >> 8, parseInt(hex[2]!, 16) & 255].join('.') : undefined);
    return mapped ? PRIVATE_V4.some((re) => re.test(mapped)) : false;
  }
  return (
    host === 'localhost' ||
    !host.includes('.') ||
    ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet'].some((suffix) => host.endsWith(suffix))
  );
}
