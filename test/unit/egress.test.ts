import { describe, expect, it } from 'vitest';
import { Egress, EgressBlockedError, InvalidBaseUrlError, isInsecureRemote, isLoopbackHost, parseBaseUrl } from '../../src/net/egress';

function fakeFetch(responses: Record<string, { status: number; location?: string }>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const r = responses[url] ?? { status: 200 };
    return new Response(r.status === 200 ? 'ok' : null, { status: r.status, headers: r.location ? { location: r.location } : {} });
  };
  return { calls, impl };
}

describe('parseBaseUrl', () => {
  it('normalizes trailing slashes and keeps a path prefix', () => {
    expect(parseBaseUrl(' http://localhost:8090/ ')).toEqual({ origin: 'http://localhost:8090', pathPrefix: '', href: 'http://localhost:8090' });
    expect(parseBaseUrl('https://ai.example.org/owui//').href).toBe('https://ai.example.org/owui');
  });

  it('rejects unusable URLs', () => {
    for (const bad of ['', 'localhost:8090', 'ftp://x', 'http://user:pw@host', 'http://h/?q=1', 'http://h/#x']) {
      expect(() => parseBaseUrl(bad)).toThrow(InvalidBaseUrlError);
    }
  });

  it('flags plain HTTP only for non-loopback hosts', () => {
    expect(isInsecureRemote(parseBaseUrl('http://127.0.0.1:3000'))).toBe(false);
    expect(isInsecureRemote(parseBaseUrl('http://[::1]:3000'))).toBe(false);
    expect(isInsecureRemote(parseBaseUrl('http://192.168.1.5:3000'))).toBe(true);
    expect(isInsecureRemote(parseBaseUrl('https://192.168.1.5'))).toBe(false);
  });

  it('recognizes loopback hosts', () => {
    expect(['localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]', 'app.localhost'].every(isLoopbackHost)).toBe(true);
    expect(['10.0.0.1', 'localhost.evil.com', '0.0.0.0'].some(isLoopbackHost)).toBe(false);
  });
});

describe('Egress', () => {
  it('only sends requests under the configured base URL', async () => {
    const f = fakeFetch({});
    const e = new Egress(() => 'http://localhost:8090/owui', f.impl);
    await e.request('/api/models');
    expect(f.calls).toEqual(['http://localhost:8090/owui/api/models']);
    await expect(e.request('https://evil.example/api')).rejects.toThrow(EgressBlockedError);
    await expect(e.request('/../other')).rejects.toThrow(EgressBlockedError);
    expect(e.resolve('//evil.example/x')).toBe('http://localhost:8090/owui//evil.example/x');
    expect(f.calls).toEqual(['http://localhost:8090/owui/api/models']);
  });

  it('refuses paths that escape the base path prefix', async () => {
    const f = fakeFetch({});
    const e = new Egress(() => 'http://localhost:8090/owui', f.impl);
    expect(() => e.resolve('@evil.example/x')).toThrow(EgressBlockedError);
    expect(e.resolve('/api/x')).toBe('http://localhost:8090/owui/api/x');
  });

  it('follows same-origin redirects and blocks cross-origin ones', async () => {
    const f = fakeFetch({
      'http://localhost:8090/api/a': { status: 307, location: '/api/b' },
      'http://localhost:8090/api/c': { status: 302, location: 'https://tracker.example/collect' },
    });
    const e = new Egress(() => 'http://localhost:8090', f.impl);
    const res = await e.request('/api/a');
    expect(res.status).toBe(200);
    expect(f.calls).toEqual(['http://localhost:8090/api/a', 'http://localhost:8090/api/b']);
    await expect(e.request('/api/c')).rejects.toThrow(/tracker\.example/);
    expect(f.calls).not.toContain('https://tracker.example/collect');
  });

  it('stops redirect loops', async () => {
    const f = fakeFetch({ 'http://localhost:8090/api/loop': { status: 302, location: '/api/loop' } });
    const e = new Egress(() => 'http://localhost:8090', f.impl);
    await expect(e.request('/api/loop')).rejects.toThrow(/too many redirects/);
  });

  it('re-reads the base URL on every request', async () => {
    let base = 'http://localhost:1';
    const f = fakeFetch({});
    const e = new Egress(() => base, f.impl);
    await e.request('/x');
    base = 'http://localhost:2';
    await e.request('/x');
    expect(f.calls).toEqual(['http://localhost:1/x', 'http://localhost:2/x']);
  });
});
