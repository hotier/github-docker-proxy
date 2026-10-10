// 平台用量累计模块单元测试：按东八区日幂等落库、只增不减、整月出窗后封存为月桶
// 时间全部钉在 NOW 上，避免用例随真实日期进入不同月份

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateDailyRows,
  setPlatformUsageStore,
  type ArchiveOptions,
  type PlatformUsage,
} from '../src/lib/platform-usage.ts';

const g = globalThis as any;

// CN 2026-10-10 20:00：8 天窗口 = 2026-10-02 起，9 月及更早的月都已整月出窗
const NOW = Date.UTC(2026, 9, 10, 12);
const OPT: ArchiveOptions = { windowDays: 8, now: NOW };

const usage = (requests: number, cpuMs: number, ingress: number, egress: number): PlatformUsage => ({
  requests,
  cpuMs,
  ingressBytes: ingress,
  egressBytes: egress,
});

function fakeKv() {
  const rows = new Map<string, PlatformUsage>();
  const keys = ['pu2/d', 'pu2/m'];
  const sets: string[] = [];
  const dels: string[] = [];
  const kv = {
    async get(key: string[]) {
      return { value: rows.get(key.join('/')) ?? null };
    },
    async set(key: string[], value: any) {
      sets.push(key.join('/'));
      rows.set(key.join('/'), value);
    },
    async delete(key: string[]) {
      dels.push(key.join('/'));
      rows.delete(key.join('/'));
    },
    list(selection: any) {
      const prefix: string[] = selection.prefix;
      const head = prefix.join('/');
      assert.ok(keys.includes(head), `不该列出未知前缀: ${head}`);
      const matched = [...rows.keys()].filter((key) => key.startsWith(`${head}/`));
      return (async function* () {
        for (const key of matched) yield { key: key.split('/'), value: rows.get(key) };
      })();
    },
  };
  return { kv, rows, sets, dels };
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
  it('按东八区日聚合落库，累计为各日求和', async () => {
    const result = await accumulateDailyRows(
      [
        { day: '2026-10-09', usage: usage(10, 1000, 100, 200) },
        { day: '2026-10-10', usage: usage(4, 400, 40, 80) },
      ],
      OPT
    );

    assert.equal(result.store, 'kv');
    assert.equal(result.days, 2);
    assert.deepEqual(result.total, { requests: 14, cpuMs: 1400, ingressBytes: 140, egressBytes: 280 });
    assert.equal(store.rows.get('pu2/d/2026-10-09')?.requests, 10);
  });

  it('重复读同一窗口是幂等的，累计不会重复计数', async () => {
    const rows = [{ day: '2026-10-10', usage: usage(5, 500, 50, 50) }];
    const first = await accumulateDailyRows(rows, OPT);
    const again = await accumulateDailyRows(rows, OPT);

    assert.deepEqual(again.total, first.total);
    assert.equal(store.sets.length, 1, '数值未变大时不应重复写库');
  });

  it('窗口边缘日桶被平台裁剪时不回退已存档的日值', async () => {
    await accumulateDailyRows([{ day: '2026-10-05', usage: usage(100, 9000, 900, 9000) }], OPT);
    const result = await accumulateDailyRows(
      [{ day: '2026-10-05', usage: usage(20, 1000, 100, 1000) }],
      OPT
    );

    assert.deepEqual(result.total, { requests: 100, cpuMs: 9000, ingressBytes: 900, egressBytes: 9000 });
    assert.equal(store.rows.get('pu2/d/2026-10-05')?.requests, 100);
  });

  it('平台补零的窗口内缺失日不入库，天数不虚高', async () => {
    const result = await accumulateDailyRows(
      [
        { day: '2026-10-01', usage: usage(0, 0, 0, 0) },
        { day: '2026-10-10', usage: usage(3, 300, 30, 30) },
      ],
      OPT
    );

    assert.equal(result.days, 1);
    assert.equal(store.rows.has('pu2/d/2026-10-01'), false);
    assert.deepEqual(result.total, { requests: 3, cpuMs: 300, ingressBytes: 30, egressBytes: 30 });
  });
});

describe('整月出窗后封存为月桶', () => {
  it('整月出窗后日桶封存为月桶，日键删除且累计不变', async () => {
    // 9-05 时 8 月底仍在 8 天窗口内，可能被平台回看，所以先按日存着
    const inWindow: ArchiveOptions = { windowDays: 8, now: Date.UTC(2026, 8, 5, 12) };
    await accumulateDailyRows([{ day: '2026-08-01', usage: usage(7, 700, 70, 70) }], inWindow);
    await accumulateDailyRows([{ day: '2026-08-15', usage: usage(3, 300, 30, 30) }], inWindow);
    assert.equal(store.rows.has('pu2/m/2026-08'), false);
    assert.equal(store.rows.get('pu2/d/2026-08-15')?.requests, 3);

    // 时间走到 10-10，8 月整月已滑出窗口：两个日键合并封进月桶，日键删掉
    const result = await accumulateDailyRows([{ day: '2026-10-10', usage: usage(3, 300, 30, 30) }], OPT);

    assert.deepEqual(store.rows.get('pu2/m/2026-08'), {
      requests: 10,
      cpuMs: 1000,
      ingressBytes: 100,
      egressBytes: 100,
    });
    assert.equal(store.rows.has('pu2/d/2026-08-01'), false);
    assert.equal(store.rows.has('pu2/d/2026-08-15'), false);
    assert.deepEqual(result.total, { requests: 13, cpuMs: 1300, ingressBytes: 130, egressBytes: 130 });
  });

  it('封存后累计不变，重复调用不会把该月再算一遍', async () => {
    const rows = [
      { day: '2026-09-20', usage: usage(40, 4000, 400, 4000) },
      { day: '2026-10-10', usage: usage(3, 300, 30, 30) },
    ];
    const first = await accumulateDailyRows(rows, OPT);
    const again = await accumulateDailyRows(rows, OPT);

    assert.deepEqual(again.total, first.total);
    assert.equal(store.rows.has('pu2/m/2026-09'), true);
    assert.equal(store.rows.has('pu2/d/2026-09-20'), false);
  });

  it('days 按归档覆盖的自然日数计：封存的月计整月天数', async () => {
    const result = await accumulateDailyRows(
      [
        { day: '2026-08-31', usage: usage(1, 100, 10, 10) },
        { day: '2026-10-10', usage: usage(3, 300, 30, 30) },
      ],
      OPT
    );

    // 8 月封成月桶计 31 天，10-10 仍是日键计 1 天
    assert.equal(result.days, 32);
  });

  it('仍在查询窗口内的月份不封存，避免窗口回看时重复累加', async () => {
    // now 落在 10-04：窗口 8 天覆盖到 09-26，9 月尚未整月出窗
    const early: ArchiveOptions = { windowDays: 8, now: Date.UTC(2026, 9, 4, 12) };
    const result = await accumulateDailyRows([{ day: '2026-09-28', usage: usage(9, 900, 90, 90) }], early);

    assert.equal(store.rows.has('pu2/m/2026-09'), false);
    assert.equal(store.rows.get('pu2/d/2026-09-28')?.requests, 9);
    assert.deepEqual(result.total, { requests: 9, cpuMs: 900, ingressBytes: 90, egressBytes: 90 });
  });
});

describe('归档后端降级', () => {
  it('归档不可用时降级为本次窗口求和，不影响今日', async () => {
    setPlatformUsageStore({
      name: 'broken',
      async readMonths() {
        return new Map();
      },
      async readDays() {
        throw new Error('KV unavailable');
      },
      async writeDay() {},
      async writeMonth() {},
      async deleteDays() {},
    });

    const result = await accumulateDailyRows(
      [
        { day: '2026-10-09', usage: usage(4, 400, 40, 40) },
        { day: '2026-10-10', usage: usage(6, 600, 60, 60) },
      ],
      OPT
    );

    assert.equal(result.degraded, true);
    assert.equal(result.store, 'unavailable');
    assert.deepEqual(result.total, { requests: 10, cpuMs: 1000, ingressBytes: 100, egressBytes: 100 });
  });

  it('无 KV 时退化为内存后端，接口仍然可用', async () => {
    delete g.Deno;
    setPlatformUsageStore(null);

    const result = await accumulateDailyRows([{ day: '2026-10-10', usage: usage(2, 200, 20, 20) }], OPT);
    assert.equal(result.store, 'memory');
    assert.equal(result.total.requests, 2);

    const again = await accumulateDailyRows([{ day: '2026-10-10', usage: usage(2, 200, 20, 20) }], OPT);
    assert.equal(again.total.requests, 2, '内存后端重复写入不应翻倍');
  });
});
