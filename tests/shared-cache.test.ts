// 跨冷启动共享缓存的单元测试：命中即不回源、未命中回源后写回 KV、
// force 绕过两层、KV 或 producer 故障都只是退回回源而不影响本次结果
// 「新实例的第一批请求」用「进程内没见过的 key」来模拟：两者都是本地层为空、KV 层有值

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { cachedJsonShared } from '../src/lib/shared-cache.ts';

const g = globalThis as any;
const TTL = 60_000;

function fakeKv() {
  const rows = new Map<string, any>();
  const writes: { key: string; expireIn?: number }[] = [];
  let failRead = false;
  const kv = {
    async get(key: string[]) {
      if (failRead) throw new Error('kv unavailable');
      return { value: rows.get(key.join('/')) ?? null };
    },
    async set(key: string[], value: any, options?: { expireIn?: number }) {
      rows.set(key.join('/'), value);
      writes.push({ key: key.join('/'), expireIn: options?.expireIn });
    },
  };
  return { kv, rows, writes, failRead: () => (failRead = true) };
}

let store: ReturnType<typeof fakeKv>;

beforeEach(() => {
  store = fakeKv();
  g.Deno = { Kv: store.kv };
});

afterEach(() => {
  delete g.Deno;
});

describe('共享结果缓存', () => {
  it('首次回源后写入 KV，同一实例的后续请求不再回源', async () => {
    let calls = 0;
    const produce = async () => ({ n: ++calls });

    assert.deepEqual(await cachedJsonShared('a', TTL, produce), { n: 1 });
    assert.deepEqual(await cachedJsonShared('a', TTL, produce), { n: 1 });
    assert.equal(calls, 1);

    const entry = store.rows.get('shared-cache/a');
    assert.deepEqual(entry.data, { n: 1 });
    assert.equal(store.writes[0].expireIn, TTL);
  });

  it('本地层为空但 KV 有值时直接命中，不执行 producer', async () => {
    store.rows.set('shared-cache/booted', { at: Date.now() - 1000, data: { from: 'kv' } });
    let calls = 0;

    const data = await cachedJsonShared('booted', TTL, async () => ({ n: ++calls }));

    assert.deepEqual(data, { from: 'kv' });
    assert.equal(calls, 0);
  });

  it('force 跳过两层缓存，回源并覆盖 KV', async () => {
    store.rows.set('shared-cache/f', { at: Date.now(), data: { from: 'kv' } });

    const data = await cachedJsonShared('f', TTL, async () => ({ from: 'upstream' }), true);

    assert.deepEqual(data, { from: 'upstream' });
    assert.deepEqual(store.rows.get('shared-cache/f').data, { from: 'upstream' });
  });

  it('并发请求共享同一次回源', async () => {
    let calls = 0;
    const produce = () => {
      calls++;
      return new Promise((resolve) => setTimeout(() => resolve({ n: calls }), 10));
    };

    assert.deepEqual(await Promise.all([cachedJsonShared('c', TTL, produce), cachedJsonShared('c', TTL, produce)]), [
      { n: 1 },
      { n: 1 },
    ]);
    assert.equal(calls, 1);
  });

  it('KV 读失败只是退回回源，不影响本次结果', async () => {
    store.failRead();

    assert.deepEqual(await cachedJsonShared('broken', TTL, async () => ({ ok: true })), { ok: true });
  });

  it('producer 抛错不入缓存，下个请求重试', async () => {
    let calls = 0;
    const produce = async () => {
      if (++calls === 1) throw new Error('upstream down');
      return { n: calls };
    };

    await assert.rejects(() => cachedJsonShared('p', TTL, produce), /upstream down/);
    assert.equal(store.rows.has('shared-cache/p'), false);
    assert.deepEqual(await cachedJsonShared('p', TTL, produce), { n: 2 });
  });

  it('没有 KV 的环境退化为进程内缓存', async () => {
    delete g.Deno;
    let calls = 0;
    const produce = async () => ({ n: ++calls });

    assert.deepEqual(await cachedJsonShared('memory', TTL, produce), { n: 1 });
    assert.deepEqual(await cachedJsonShared('memory', TTL, produce), { n: 1 });
    assert.equal(calls, 1);
  });
});
