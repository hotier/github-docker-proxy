// 平台用量累计模块单元测试：按 UTC 日幂等落库、只增不减、更早日期出窗后仍计入累计

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateDailyRows,
  setPlatformUsageStore,
  type PlatformUsage,
} from '../src/lib/platform-usage.ts';

const g = globalThis as any;

const usage = (requests: number, cpuMs: number, ingress: number, egress: number): PlatformUsage => ({
  requests,
  cpuMs,
  ingressBytes: ingress,
  egressBytes: egress,
});

function fakeKv() {
  const days = new Map<string, PlatformUsage>();
  const sets: string[] = [];
  const kv = {
    async get(key: string[]) {
      return { value: days.get(key.join('/')) ?? null };
    },
    async set(key: string[], value: any) {
      sets.push(key.join('/'));
      days.set(key.join('/'), value);
    },
    list(selection: any) {
      const prefix: string[] = selection.prefix;
      const matched = [...days.keys()].filter((key) =>
        prefix.every((part, i) => key.split('/')[i] === part)
      );
      return (async function* () {
        for (const key of matched) yield { key: key.split('/'), value: days.get(key) };
      })();
    },
  };
  return { kv, days, sets };
}

let store: ReturnType<typeof fakeKv>;

beforeEach(() => {
  store = fakeKv();
  g.Deno = { Kv: store.kv };
  setPlatformUsageStore(null);
});

afterEach(() => {
  delete g.Deno;
  setPlatformUsageStore(null);
});

describe('平台用量累计（KV 日存档）', () => {
  it('按 UTC 日聚合落库，累计为各日求和', async () => {
    const result = await accumulateDailyRows([
      { day: '2026-10-09', usage: usage(10, 1000, 100, 200) },
      { day: '2026-10-10', usage: usage(4, 400, 40, 80) },
    ]);

    assert.equal(result.store, 'kv');
    assert.equal(result.days, 2);
    assert.deepEqual(result.total, { requests: 14, cpuMs: 1400, ingressBytes: 140, egressBytes: 280 });
    assert.equal(store.days.get('pu/d/2026-10-09')?.requests, 10);
  });

  it('重复读同一窗口是幂等的，累计不会重复计数', async () => {
    const rows = [{ day: '2026-10-10', usage: usage(5, 500, 50, 50) }];
    const first = await accumulateDailyRows(rows);
    const again = await accumulateDailyRows(rows);

    assert.deepEqual(again.total, first.total);
    assert.equal(store.sets.length, 1, '数值未变大时不应重复写库');
  });

  it('窗口边缘日桶被平台裁剪时不回退已存档的日值', async () => {
    await accumulateDailyRows([{ day: '2026-09-20', usage: usage(100, 9000, 900, 9000) }]);
    const result = await accumulateDailyRows([{ day: '2026-09-20', usage: usage(20, 1000, 100, 1000) }]);

    assert.deepEqual(result.total, { requests: 100, cpuMs: 9000, ingressBytes: 900, egressBytes: 9000 });
    assert.equal(store.days.get('pu/d/2026-09-20')?.requests, 100);
  });

  it('更早日期出窗后仍计入累计，只增不减', async () => {
    await accumulateDailyRows([{ day: '2026-08-01', usage: usage(7, 700, 70, 70) }]);
    const result = await accumulateDailyRows([{ day: '2026-10-10', usage: usage(3, 300, 30, 30) }]);

    assert.equal(result.days, 2);
    assert.deepEqual(result.total, { requests: 10, cpuMs: 1000, ingressBytes: 100, egressBytes: 100 });
  });

  it('平台补零的窗口内缺失日不入库，天数不虚高', async () => {
    const result = await accumulateDailyRows([
      { day: '2026-09-01', usage: usage(0, 0, 0, 0) },
      { day: '2026-10-10', usage: usage(3, 300, 30, 30) },
    ]);

    assert.equal(result.days, 1);
    assert.equal(store.days.has('pu/d/2026-09-01'), false);
    assert.deepEqual(result.total, { requests: 3, cpuMs: 300, ingressBytes: 30, egressBytes: 30 });
  });

  it('归档后端不可用时降级为本次窗口求和，不影响今日', async () => {
    setPlatformUsageStore({
      name: 'broken',
      async readDays() {
        throw new Error('KV unavailable');
      },
      async writeDay() {},
    });

    const result = await accumulateDailyRows([
      { day: '2026-10-09', usage: usage(4, 400, 40, 40) },
      { day: '2026-10-10', usage: usage(6, 600, 60, 60) },
    ]);

    assert.equal(result.degraded, true);
    assert.equal(result.store, 'unavailable');
    assert.deepEqual(result.total, { requests: 10, cpuMs: 1000, ingressBytes: 100, egressBytes: 100 });
  });

  it('无 KV 时退化为内存后端，接口仍然可用', async () => {
    delete g.Deno;
    setPlatformUsageStore(null);

    const result = await accumulateDailyRows([{ day: '2026-10-10', usage: usage(2, 200, 20, 20) }]);
    assert.equal(result.store, 'memory');
    assert.equal(result.total.requests, 2);

    const again = await accumulateDailyRows([{ day: '2026-10-10', usage: usage(2, 200, 20, 20) }]);
    assert.equal(again.total.requests, 2, '内存后端重复写入不应翻倍');
  });
});
