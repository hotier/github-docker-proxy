// 客户端断开后不再替它搬运上游响应：上游 fetch 必须挂在客户端的 abort 信号上，
// 否则 isolate 会把整份文件从上游读完，出口额度与 CPU 照付，收件人却已经走了

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { proxyRequest, handleDockerProxy } from '../src/lib/proxy.ts';

const g = globalThis as any;

let original: any;
let calls: Array<{ url: string; signal: AbortSignal | undefined }>;

// registry 探测顺序是 401 -> 取 token -> 重试，token 端点按返回值区分
function stubFetch(steps: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  original = g.fetch;
  calls = [];
  let index = 0;
  g.fetch = async (url: string, options: any) => {
    const signal = options?.signal;
    calls.push({ url: String(url), signal });
    if (String(url).includes('auth.docker.io')) {
      return new Response(JSON.stringify({ token: 'exchanged' }));
    }
    const step = steps[Math.min(index++, steps.length - 1)];
    return new Response(step.body ?? 'ok', { status: step.status, headers: step.headers });
  };
}

function client(path: string, signal?: AbortSignal) {
  return new Request('http://proxy.test' + path, { signal });
}

describe('客户端中断的传播', () => {
  afterEach(() => {
    g.fetch = original;
  });

  it('透传路径把客户端信号交给上游', async () => {
    stubFetch([{ status: 200 }]);
    const controller = new AbortController();
    const req = client('/api/gh/owner/repo/file.bin', controller.signal);
    await proxyRequest(req, 'https://github.com', '/owner/repo/file.bin', '');
    assert.equal(calls[0].signal, req.signal);
    controller.abort();
    assert.equal(calls[0].signal?.aborted, true);
  });

  it('registry 的 401 重试同样带信号，取 token 不受影响', async () => {
    stubFetch([
      { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' } },
      { status: 200 },
    ]);
    const controller = new AbortController();
    const req = client('/v2/library/nginx/manifests/latest', controller.signal);
    await handleDockerProxy(
      req,
      '/v2/library/nginx/manifests/latest',
      '',
      'https://registry-1.docker.io',
      'https://auth.docker.io'
    );
    const targets = calls.filter((call) => call.url.includes('registry-1.docker.io'));
    assert.equal(targets.length, 2);
    assert.equal(targets[0].signal, req.signal);
    assert.equal(targets[1].signal, req.signal);
  });
});
