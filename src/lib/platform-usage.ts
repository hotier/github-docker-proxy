// 平台用量累计：Deno 分析接口只返回请求窗口内的 15 分钟桶，保留期没有公开承诺
// （新版控制台历史上也只给 24h/7d/30d 档位），所以累计值不依赖长窗口查询。
// 写模型：按东八区自然日聚合后整日覆盖写入，写同一个日键是幂等的，多实例并发不会重复计数
// 读模型：累计 = KV 里全部日键求和，日键数 = 应用运行天数，读取成本线性且有 5 分钟服务端缓存
// 后端：Deno KV(生产)，内存(dev/test)，与 lib/stats.ts 的注入方式一致

import { cnDay } from './cn-date.ts';

export type PlatformUsage = {
  requests: number;
  // CPU 时间按毫秒存整数，避免浮点在累加中漂移
  cpuMs: number;
  ingressBytes: number;
  egressBytes: number;
};

export type DayRow = { day: string; usage: PlatformUsage };

export interface PlatformUsageStore {
  readonly name: string;
  readDays(): Promise<Map<string, PlatformUsage>>;
  writeDay(day: string, usage: PlatformUsage): Promise<void>;
}

const DAY_PREFIX = 'pu';

// 指标清单只在这里维护一次：新增一项不必再改加和/比较/空值判断
const USAGE_KEYS: (keyof PlatformUsage)[] = ['requests', 'cpuMs', 'ingressBytes', 'egressBytes'];

export function emptyUsage(): PlatformUsage {
  return { requests: 0, cpuMs: 0, ingressBytes: 0, egressBytes: 0 };
}

export function addUsage(target: PlatformUsage, delta: PlatformUsage): PlatformUsage {
  for (const key of USAGE_KEYS) target[key] += delta[key];
  return target;
}

// 桶时间(UTC ISO) -> 所属东八区自然日
export function dayOf(bucketTime: string): string {
  return cnDay(new Date(bucketTime).getTime());
}

class MemoryStore implements PlatformUsageStore {
  readonly name = 'memory';
  private days = new Map<string, PlatformUsage>();

  async readDays() {
    return new Map([...this.days].map(([day, usage]) => [day, { ...usage }]));
  }

  async writeDay(day: string, usage: PlatformUsage) {
    this.days.set(day, { ...usage });
  }
}

class KvStore implements PlatformUsageStore {
  readonly name = 'kv';
  private kv: any;

  constructor(kv: any) {
    this.kv = kv;
  }

  async readDays() {
    const out = new Map<string, PlatformUsage>();
    for await (const entry of this.kv.list({ prefix: [DAY_PREFIX, 'd'] })) {
      const day = (entry.key as string[])[2];
      if (day && entry.value) out.set(day, entry.value as PlatformUsage);
    }
    return out;
  }

  async writeDay(day: string, usage: PlatformUsage) {
    await this.kv.set([DAY_PREFIX, 'd', day], usage);
  }
}

let activeStore: PlatformUsageStore | null = null;
let storePromise: Promise<PlatformUsageStore> | null = null;

async function getStore(): Promise<PlatformUsageStore> {
  if (activeStore) return activeStore;
  if (!storePromise) {
    storePromise = (async () => {
      const deno = (globalThis as any).Deno;
      if (deno?.Kv && typeof deno.Kv.list === 'function') return new KvStore(deno.Kv);
      if (typeof deno?.openKv === 'function') return new KvStore(await deno.openKv());
      return new MemoryStore();
    })();
  }
  activeStore = await storePromise;
  return activeStore;
}

// 注入后端（测试与特殊部署用），传 null 恢复自动检测
export function setPlatformUsageStore(store: PlatformUsageStore | null): void {
  activeStore = store;
  storePromise = store ? Promise.resolve(store) : null;
}

export type ArchivedUsage = {
  total: PlatformUsage;
  store: string;
  days: number;
  // 归档不可用时累计只覆盖本次窗口，页面需要如实说明，不能让人以为是全量
  degraded: boolean;
};

// 整日覆盖写入，只写有增长的日键：窗口边缘的历史日可能已被平台裁剪掉一部分桶，
// 此时重算的日值偏小，回写会把累计拉低，所以只在数值变大时落库。
// 归档读写失败不牵连「今日」：退回本次窗口求和并标记 degraded。
export async function accumulateDailyRows(rows: DayRow[]): Promise<ArchivedUsage> {
  let store: PlatformUsageStore;
  let stored: Map<string, PlatformUsage>;
  try {
    store = await getStore();
    stored = await store.readDays();
  } catch (error) {
    console.error('Platform usage archive unreadable, falling back to the fetched window:', error);
    return {
      total: sumUsage(rows.map((row) => row.usage)),
      store: 'unavailable',
      days: rows.length,
      degraded: true
    };
  }

  try {
    for (const { day, usage } of rows) {
      if (isBlank(usage)) continue;
      const prev = stored.get(day);
      if (prev && !grew(usage, prev)) {
        if (declined(usage, prev)) {
          console.warn(`平台用量回填窗口内 ${day} 的数值低于已存档值，累计保持已存档口径`, prev, usage);
        }
        continue;
      }
      await store.writeDay(day, usage);
      stored.set(day, usage);
    }
  } catch (error) {
    console.error('Platform usage archive write failed, cumulative may lag:', error);
  }

  return { total: sumUsage([...stored.values()]), store: store.name, days: stored.size, degraded: false };
}

function sumUsage(items: PlatformUsage[]): PlatformUsage {
  return items.reduce((acc, usage) => addUsage(acc, { ...usage }), emptyUsage());
}

// 平台对返回范围内缺失的桶补零，应用上线前的日子会全零入库，把 days 撑虚高
function isBlank(usage: PlatformUsage): boolean {
  return USAGE_KEYS.every((key) => usage[key] === 0);
}

function grew(next: PlatformUsage, prev: PlatformUsage): boolean {
  return USAGE_KEYS.some((key) => next[key] > prev[key]);
}

function declined(next: PlatformUsage, prev: PlatformUsage): boolean {
  return USAGE_KEYS.some((key) => next[key] < prev[key]);
}
