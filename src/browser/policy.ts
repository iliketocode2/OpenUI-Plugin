import { isLoopbackHost } from '../net/egress';

const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:']);

export interface BrowserPolicy {
  allowExternal: boolean;
  extraHosts: string[];
}

export function isAllowedBrowserUrl(raw: string, policy: BrowserPolicy): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (LOCAL_SCHEMES.has(url.protocol)) return true;
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
  if (policy.allowExternal) return true;
  const host = url.hostname.toLowerCase();
  return isLoopbackHost(host) || policy.extraHosts.some((h) => h.trim().toLowerCase() === host);
}

export function navigationError(raw: string, policy: BrowserPolicy): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a valid URL. Use a full URL such as http://localhost:3000/.`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http:// and https:// URLs can be opened.';
  if (!isAllowedBrowserUrl(raw, policy)) {
    return `The browser tool only opens local development servers (localhost, 127.0.0.1, ::1${policy.extraHosts.length ? `, ${policy.extraHosts.join(', ')}` : ''}). ${url.hostname} is not allowed.`;
  }
  return undefined;
}
