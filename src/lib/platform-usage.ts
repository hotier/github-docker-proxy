// 平台用量累计：分析接口只返回查询窗口内的 15 分钟桶，且实测存在没写进文档的有效
// 上限（请求 35 天只回最近约 31 天），所以累计值不能依赖长窗口查询。
// 键布局：日桶 pu2/d/<YYYY-MM-DD>（当月滚动覆盖，幂等）；月桶 pu2/m/<YYYY-MM>（整月封出
// 窗口后汇总封存并删掉该月日键）→ 读取成本从 O(运行天数) 降到 O(运行月数)。
// 为什么换前缀：pu/d/* 是切东八区日界前按 UTC 日写的，键名与现口径错位，而写入守卫只认
// 增长、永远不会被更小的重算值覆盖，双计的残留键清不掉，只能换前缀重建档。
// 后端：Deno KV(生产)，内存(dev/test)，与 lib/stats.ts 的注入方式一致

import { CN_OFFSET_MS, cnDay } from './cn-date.ts';
import { getKv } from './kv.ts';

export type PlatformUsage = {
  requests: number;
  // CPU 时间按毫秒存整数，避免浮点在累加中漂移
  cpuMs: number;
  ingressBytes: number;
  egressBytes: number;
};

export type DayRow = { day: string; usage: PlatformUsage };

export type ArchiveOptions = {
  // 调用方实际查询的天数窗口：只有整月都滑出窗口之后才封存，避免封过的月又被回看重写
  windowDays: number;
  now?: number;
};

export interface PlatformUsageStore {
  readonly name: string;
  readDays(): Promise<Map<string, PlatformUsage>>;
  writeDay(day: string, usage: PlatformUsage): Promise<void>;
  deleteDays(days: string[]): Promise<void>;
  readMonths(): Promise<Map<string, PlatformUsage>>;
  writeMonth(month: string, usage: PlatformUsage): Promise<void>;
}

const KEY_ROOT = 'pu2';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  private months = new Map<string, PlatformUsage>();

  async readDays() {
    return new Map([...this.days].map(([day, usage]) => [day, { ...usage }]));
  }

  async writeDay(day: string, usage: PlatformUsage) {
    this.days.set(day, { ...usage });
  }

  async deleteDays(days: string[]) {
    for (const day of days) this.days.delete(day);
  }

  async readMonths() {
    return new Map([...this.months].map(([month, usage]) => [month, { ...usage }]));
  }

  async writeMonth(month: string, usage: PlatformUsage) {
    this.months.set(month, { ...usage });
  }
}

class KvStore implements PlatformUsageStore {
  readonly name = 'kv';
  private kv: any;

  constructor(kv: any) {
    this.kv = kv;
  }

  // 日键与月键同构：一次 list 取回该层全部条目，累计读取只按桶的层数付费，不按运行时长付费
  private async list(kind: 'd' | 'm') {
    const out = new Map<string, PlatformUsage>();
    for await (const entry of this.kv.list({ prefix: [KEY_ROOT, kind] })) {
      const key = (entry.key as string[])[2];
      if (key && entry.value) out.set(key, entry.value as PlatformUsage);
    }
    return out;
  }

  readDays() {
    return this.list('d');
  }

  async writeDay(day: string, usage: PlatformUsage) {
    await this.kv.set([KEY_ROOT, 'd', day], usage);
  }

  async deleteDays(days: string[]) {
    for (const day of days) await this.kv.delete([KEY_ROOT, 'd', day]);
  }

  readMonths() {
    return this.list('m');
  }

  async writeMonth(month: string, usage: PlatformUsage) {
    await this.kv.set([KEY_ROOT, 'm', month], usage);
  }
}

let activeStore: PlatformUsageStore | null = null;
let storePromise: Promise<PlatformUsageStore> | null = null;

async function getStore(): Promise<PlatformUsageStore> {
  if (activeStore) return activeStore;
  if (!storePromise) {
    storePromise = (async () => {
      const kv = await getKv();
      return kv ? new KvStore(kv) : new MemoryStore();
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
  // 归档覆盖的自然日数：日键按个计，封存的月按该月实际天数计
  days: number;
  // 归档不可用时累计只覆盖本次窗口，页面需要如实说明，不能让人以为是全量
  degraded: boolean;
};

// 整日覆盖写入，只写有增长的日键：窗口边缘的历史日可能已被平台裁剪掉一部分桶，
// 此时重算的日值偏小，回写会把累计拉低，所以只在数值变大时落库。
// 归档读写失败不牵连「今日」：退回本次窗口求和并标记 degraded。
export async function accumulateDailyRows(
  rows: DayRow[],
  options: ArchiveOptions
): Promise<ArchivedUsage> {
  const now = options.now ?? Date.now();
  let store: PlatformUsageStore;
  let days: Map<string, PlatformUsage>;
  let months: Map<string, PlatformUsage>;
  try {
    store = await getStore();
    months = await store.readMonths();
    days = await store.readDays();
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
      // 封过的月不再回写日键：正常走不到这里（封存的前提就是整月已滑出窗口），
      // 只有窗口被调宽时才可能重新取到该月的桶
      if (months.has(monthOf(day))) continue;
      const prev = days.get(day);
      if (prev && !grew(usage, prev)) {
        if (declined(usage, prev)) {
          console.warn(`平台用量回填窗口内 ${day} 的数值低于已存档值，累计保持已存档口径`, prev, usage);
        }
        continue;
      }
      await store.writeDay(day, usage);
      days.set(day, usage);
    }

    // 整月都出窗之后才封存：此时平台不会再返回该月的桶，不存在「封了又被回看、重复累加」的循环
    const windowStart = now - options.windowDays * DAY_MS;
    const sealable = new Map<string, string[]>();
    for (const day of days.keys()) {
      const month = monthOf(day);
      if (months.has(month) || monthEndUtc(month) > windowStart) continue;
      const group = sealable.get(month);
      if (group) group.push(day);
      else sealable.set(month, [day]);
    }
    for (const [month, monthDays] of sealable) {
      const sealed = monthDays.reduce((acc, day) => addUsage(acc, days.get(day)!), emptyUsage());
      await store.writeMonth(month, sealed);
      months.set(month, sealed);
      await store.deleteDays(monthDays);
      for (const day of monthDays) days.delete(day);
    }
  } catch (error) {
    console.error('Platform usage archive write failed, cumulative may lag:', error);
  }

  let archivedDays = days.size;
  for (const month of months.keys()) archivedDays += daysInMonth(month);

  return {
    total: sumUsage([...days.values(), ...months.values()]),
    store: store.name,
    days: archivedDays,
    degraded: false
  };
}

function monthOf(day: string): string {
  return day.slice(0, 7);
}

// 该月最后一刻(UTC 毫秒) = 次月 1 日东八区 00:00；日固定 +08:00，边界可直接算
function monthEndUtc(month: string): number {
  const [year, m] = month.split('-').map(Number);
  return Date.UTC(year, m, 1) - CN_OFFSET_MS;
}

function daysInMonth(month: string): number {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
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
