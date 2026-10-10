// 统计模块单元测试：写模型（缓冲 + KV sum）、按服务拆分、访客按日去重、按天存档与保留期

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  flush,
  getDayArchive,
  getStats,
  purgeExpiredDays,
  recordRequest,
  setStore,
  trackPageView,
} from '../src/lib/stats.ts';

const g = globalThis as any;

describe('内存后端统计', () => {
  beforeEach(() => {
    g.Deno = undefined;
    setStore(null);
  });

  it('按服务拆分请求数、字节、错误与平均延迟', async () => {
    recordRequest({ service: 'github', bytes: 1000, status: 200, durationMs: 100 });
    recordRequest({ service: 'github', bytes: 500, status: 500, durationMs: 300 });
    recordRequest({ service: 'docker', bytes: 2048, status: 200, durationMs: 50 });

    const stats = await getStats();
    assert.equal(stats.store, 'memory');
    assert.equal(stats.today.github.requests, 2);
    assert.equal(stats.today.github.bytes, 1500);
    assert.equal(stats.today.github.errors, 1);
    assert.equal(stats.today.github.avgLatencyMs, 200);
    assert.equal(stats.today.docker.requests, 1);
    assert.equal(stats.today.docker.bytes, 2048);
    assert.equal(stats.today.docker.errors, 0);
    // 累计桶与今日桶同步增长
    assert.equal(stats.total.github.requests, 2);
    assert.equal(stats.total.docker.bytes, 2048);
  });

  it('缓冲在读取前落库，读后不重复计数', async () => {
    recordRequest({ service: 'github', bytes: 10, status: 200, durationMs: 5 });
    const first = await getStats();
    assert.equal(first.today.github.requests, 1);
    await flush();
    const second = await getStats();
    assert.equal(second.today.github.requests, 1);
  });

  it('访客按日去重，浏览量单独计', async () => {
    await trackPageView('1.1.1.1', 'curl/8');
    await trackPageView('1.1.1.1', 'curl/8');
    await trackPageView('2.2.2.2', 'Mozilla/5');

    const stats = await getStats();
    assert.equal(stats.today.pageViews, 3);
    assert.equal(stats.today.visitors, 2);
    assert.equal(stats.today.github.requests, 0);
  });

  it('按天存档只回看有数据的自然日，保留期清理不动累计桶', async () => {
    recordRequest({ service: 'github', bytes: 10, status: 200, durationMs: 4 });
    await trackPageView('9.9.9.9', 'curl/8');

    const archive = await getDayArchive(7);
    assert.equal(archive.store, 'memory');
    assert.equal(archive.requestedDays, 7);
    assert.equal(archive.retentionDays, 180);
    assert.equal(archive.series.length, 1, '空白天不应出现在存档里');
    assert.equal(archive.series[0].date, archive.to);
    assert.equal(archive.series[0].github.requests, 1);
    assert.equal(archive.series[0].pageViews, 1);

    await purgeExpiredDays();
    const stats = await getStats();
    assert.equal(stats.today.github.requests, 1);
    assert.equal(stats.total.github.requests, 1, '累计桶不参与按天清理');
  });
});

describe('KV 后端统计', () => {
  let counters: Map<string, bigint>;
  let visits: Map<string, { value: any; options?: any }>;
  let metas: Map<string, { value: any; options?: any }>;
  let usedCas: boolean;
  let commitCalls: number;

  const id = (key: string[]) => key.join('/');

  function fakeKv() {
    counters = new Map();
    visits = new Map();
    metas = new Map();
    usedCas = false;
    commitCalls = 0;

    // visit 与 meta 都走普通 get/set，按键首段分流，互不污染断言
    const bagFor = (key: string[]) => (key[0] === 'meta' ? metas : visits);

    return {
      atomic() {
        const batch: any[] = [];
        return {
          mutate(op: any) {
            batch.push(op);
            return this;
          },
          check() {
            usedCas = true;
            throw new Error('sum 写路径不应再使用 check/CAS');
          },
          async commit() {
            commitCalls++;
            for (const op of batch) {
              const key = id(op.key);
              if (op.type === 'delete') {
                counters.delete(key);
              } else {
                counters.set(key, (counters.get(key) ?? 0n) + op.value.value);
              }
            }
            return { ok: true };
          },
        };
      },
      list(selection: any) {
        const prefix: string[] = selection.prefix;
        const matched = [...counters.keys()].filter((key) =>
          prefix.every((part, i) => key.split('/')[i] === part)
        );
        return (async function* () {
          for (const key of matched) {
            yield { key: key.split('/'), value: counters.get(key) };
          }
        })();
      },
      async get(key: string[]) {
        return { value: bagFor(key).get(id(key))?.value ?? null };
      },
      async set(key: string[], value: any, options?: any) {
        bagFor(key).set(id(key), { value, options });
      },
    };
  }

  beforeEach(() => {
    g.Deno = {
      Kv: fakeKv(),
      KvU64: class KvU64 {
        value: bigint;
        constructor(value: bigint) {
          this.value = value;
        }
      },
    };
    setStore(null);
  });

  it('计数器用服务端 sum 自增，不做读-改-写', async () => {
    recordRequest({ service: 'docker', bytes: 4096, status: 200, durationMs: 20 });
    await flush();

    assert.equal(usedCas, false);
    assert.ok(commitCalls > 0, '应通过原子事务写入');

    const date = (await getStats()).date;
    assert.equal(counters.get(id(['st', 'd', date, 'docker', 'bytes', '0'])), 4096n);
    assert.equal(counters.get(id(['st', 'c', 'all', 'docker', 'req', '0'])), 1n);
  });

  it('读写走同一 KV 后端，今日与累计一致', async () => {
    recordRequest({ service: 'github', bytes: 123, status: 404, durationMs: 9 });
    const stats = await getStats();

    assert.equal(stats.store, 'kv');
    assert.equal(stats.today.github.requests, 1);
    assert.equal(stats.today.github.bytes, 123);
    assert.equal(stats.today.github.errors, 1);
    assert.equal(stats.total.github.requests, 1);
  });

  it('访客记录写入带 TTL，键不再无限堆积', async () => {
    await trackPageView('3.3.3.3', 'curl/8');
    await trackPageView('3.3.3.3', 'curl/8');

    assert.equal(visits.size, 1);
    assert.ok([...visits.values()][0].options?.expireIn > 0, 'visit 键必须带过期时间');

    const stats = await getStats();
    assert.equal(stats.today.pageViews, 2);
    assert.equal(stats.today.visitors, 1);
  });

  it('按天存档可回看历史日桶，超期日桶被清扫', async () => {
    const stamp = new Date();
    stamp.setDate(stamp.getDate() - 1);
    const yesterday = [
      stamp.getFullYear(),
      String(stamp.getMonth() + 1).padStart(2, '0'),
      String(stamp.getDate()).padStart(2, '0'),
    ].join('-');

    // 昨日真实存档 + 远超保留期的历史日桶 + 一个累计桶
    counters.set(id(['st', 'd', yesterday, 'docker', 'req', '0']), 5n);
    counters.set(id(['st', 'd', yesterday, 'docker', 'bytes', '0']), 5000n);
    counters.set(id(['st', 'd', '2020-01-01', 'github', 'req', '0']), 7n);
    counters.set(id(['st', 'c', 'all', 'github', 'req', '0']), 100n);

    recordRequest({ service: 'github', bytes: 100, status: 200, durationMs: 10 });
    await flush();
    const today = (await getStats()).date;
    await purgeExpiredDays();

    const archive = await getDayArchive(2);
    assert.deepEqual(archive.series.map((day) => day.date), [yesterday, today]);
    assert.equal(archive.series[0].docker.requests, 5);
    assert.equal(archive.series[0].docker.bytes, 5000);
    assert.equal(archive.series[1].github.requests, 1);

    assert.equal(counters.has(id(['st', 'd', '2020-01-01', 'github', 'req', '0'])), false);
    assert.equal(counters.has(id(['st', 'd', today, 'github', 'req', '0'])), true);
    assert.ok(metas.get(id(['meta', 'purge'])), '清扫要写标记键，多实例不必各自列库');
    assert.ok(
      [...counters.keys()].some((key) => key.startsWith(id(['st', 'c', 'all']))),
      '累计桶不参与按天清理'
    );
  });
});
