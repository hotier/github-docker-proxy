// 代理响应的可缓存性：谁的凭据取回的响应就不能进公共缓存(CDN)，
// 而本站自己声明的缓存头必须盖过上游的，顺序反了会被抹掉

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { proxyRequest } from '../src/lib/proxy.ts';
import { CONFIG } from '../src/lib/config.ts';

const g = globalThis as any;

// 记录上游请求头，便于确认身份注入没有把客户端凭据顶掉
let upstreamCall: { headers: Headers } | null = null;

function stubUpstream(init: { status?: number; headers?: Record<string, string>; body?: string }) {
  const original = g.fetch;
  g.fetch = async (_url: string, options: any) => {
    upstreamCall = { headers: new Headers(options?.headers || {}) };
    return new Response(init.body ?? 'ok', {
      status: init.status ?? 200,
      headers: init.headers,
    });
  };
  return () => {
    g.fetch = original;
    upstreamCall = null;
  };
}

function request(path = '/api/gh/owner/repo/file.bin', headers: Record<string, string> = {}) {
  return new Request('http://proxy.test' + path, { headers });
}

describe('代理响应的缓存私有性', () => {
  let restore: () => void;
  const saved = { password: CONFIG.PROXY_PASSWORD, token: CONFIG.GITHUB_TOKEN };

  beforeEach(() => {
    CONFIG.PROXY_PASSWORD = '';
    CONFIG.GITHUB_TOKEN = '';
  });
  afterEach(() => {
    restore?.();
    CONFIG.PROXY_PASSWORD = saved.password;
    CONFIG.GITHUB_TOKEN = saved.token;
  });

  it('匿名请求保留上游的公共缓存头', async () => {
    restore = stubUpstream({ headers: { 'cache-control': 'public, max-age=60' } });
    const resp = await proxyRequest(
      request(), 'https://github.com', '/owner/repo/file.bin', ''
    );
    assert.equal(resp.headers.get('cache-control'), 'public, max-age=60');
  });

  it('客户端自带的上游凭据让响应变成私有', async () => {
    restore = stubUpstream({ headers: { 'cache-control': 'public, max-age=60' } });
    const resp = await proxyRequest(
      request('/api/ghcr/v2/acme/private/manifests/latest', { authorization: 'Bearer client-token' }),
      'https://ghcr.io',
      '/v2/acme/private/manifests/latest',
      ''
    );
    assert.equal(resp.headers.get('cache-control'), 'private, no-store');
    // 客户端凭据仍然发到上游，只是响应不再可共享缓存
    assert.equal(upstreamCall?.headers.get('authorization'), 'Bearer client-token');
  });

  it('全站门禁密码不算私有凭据，代理密码下的响应仍可缓存', async () => {
    CONFIG.PROXY_PASSWORD = 'gate';
    restore = stubUpstream({ headers: { 'cache-control': 'public, max-age=60' } });
    const gate = 'Basic ' + btoa('proxy:gate');
    const viaAuth = await proxyRequest(
      request('/api/gh/owner/repo/file.bin', { authorization: gate }),
      'https://github.com', '/owner/repo/file.bin', ''
    );
    const viaKey = await proxyRequest(
      request('/api/gh/owner/repo/file.bin', { 'x-proxy-key': 'gate' }),
      'https://github.com', '/owner/repo/file.bin', ''
    );
    assert.equal(viaAuth.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(viaKey.headers.get('cache-control'), 'public, max-age=60');
    // 门禁凭据止于本代理，不会替客户端带给上游
    assert.equal(upstreamCall?.headers.get('authorization'), null);
    assert.equal(upstreamCall?.headers.get('x-proxy-key'), null);
  });

  it('我们代填 GITHUB_TOKEN 取回的响应同样私有', async () => {
    CONFIG.GITHUB_TOKEN = 'injected';
    restore = stubUpstream({ headers: { 'cache-control': 'public, max-age=60' } });
    const resp = await proxyRequest(
      request('/api/api.github.com/repos/acme/private'),
      'https://api.github.com', '/repos/acme/private', ''
    );
    assert.equal(resp.headers.get('cache-control'), 'private, no-store');
    assert.equal(upstreamCall?.headers.get('authorization'), 'Bearer injected');
  });

  it('正文改写路径同样私有', async () => {
    restore = stubUpstream({
      headers: { 'cache-control': 'public, max-age=300', 'content-type': 'application/json' },
      body: '{"dist":{"tarball":"https://registry.npmjs.org/acme/-/acme-1.0.0.tgz"}}',
    });
    const resp = await proxyRequest(
      request('/api/npm/acme', { authorization: 'Bearer client-token' }),
      'https://registry.npmjs.org', '/acme', ''
    );
    assert.equal(resp.headers.get('cache-control'), 'private, no-store');
    const body = await resp.text();
    assert.ok(body.includes('http://proxy.test/api/npm/acme/-/acme-1.0.0.tgz'), body);
  });

  it('重定向路径也私有', async () => {
    restore = stubUpstream({
      status: 302,
      headers: { location: 'https://objects.githubusercontent.com/x/y', 'cache-control': 'public, max-age=60' },
    });
    const resp = await proxyRequest(
      request('/api/gh/owner/repo/releases/download/v1/app.zip', { authorization: 'Bearer client-token' }),
      'https://github.com', '/owner/repo/releases/download/v1/app.zip', ''
    );
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get('cache-control'), 'private, no-store');
  });

  it('匿名大文件透传上游缓存头，带凭据时仍然私有', async () => {
    restore = stubUpstream({ headers: { 'cache-control': 'max-age=300' } });
    const path = '/owner/repo/releases/download/v1/app.zip';
    const anon = await proxyRequest(request(), 'https://github.com', path, '');
    assert.equal(anon.headers.get('cache-control'), 'max-age=300');

    const credentialed = await proxyRequest(
      request('/api/gh' + path, { authorization: 'Bearer client-token' }),
      'https://github.com', path, ''
    );
    assert.equal(credentialed.headers.get('cache-control'), 'private, no-store');
  });
});
