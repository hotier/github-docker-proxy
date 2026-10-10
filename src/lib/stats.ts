// 统计：请求数 / 流量字节 / 错误 / 延迟，按服务维度拆分（服务清单来自 lib/services）
// 写模型：进程内缓冲增量 -> 批量落库（KV 用服务端 sum 原子自增，不做读-改-写）
// 读模型：今日读日桶，累计读 all-time 桶
// 存档：日桶即按天存档（东八区自然日，见 lib/cn-date，不细到小时），超过保留期的日桶由清扫删除
// 后端：Deno KV(生产)，内存(dev/test)

// 显式带扩展名：本文件被 node --experimental-strip-types 的测试直接加载
import { SERVICE_NAMES, type Service } from './services.ts';
import { cnDay } from './cn-date.ts';

export type { Service };
// 站点页面访问与加速服务共用一套计数器字段，'site' 只出现在统计侧
export type StatTarget = Service | 'site';
export type Metric = 'req' | 'use' | 'bytes' | 'err' | 'ms' | 'uv';
export type Bucket = 'd' | 'c';

export type RequestEvent = {
  service: StatTarget;
  bytes: number;
  status: number;
  durationMs: number;
  // 一次「拿到内容」的取用（识别规则见 services.isUsageRequest），与 req 分开计
  usage?: boolean;
};

const ALL_TIME = 'all';
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// 清扫进度标记：跨实例共享，避免每个冷启动实例都去列一遍日桶
const PURGE_META = 'purge';

// 计数器字段统一为 service|metric
type Field = string;
type Delta = { bucket: Bucket; period: string; field: Field; value: number };

export interface StatStore {
  readonly name: string;
  addDeltas(deltas: Delta[]): Promise<void>;
  readBucket(bucket: Bucket, period: string): Promise<Map<Field, number>>;
  readMeta(key: string): Promise<string | null>;
  writeMeta(key: string, value: string): Promise<void>;
  // 删除 period < cutoff 的日桶，返回清掉的计数器键数；不触碰累计桶
  purgeDayArchive(cutoff: string): Promise<number>;
  getVisit(hash: string, period: string): Promise<number | null>;
  saveVisit(hash: string, period: string, at: number): Promise<void>;
}

function fieldOf(service: StatTarget, metric: Metric): Field {
  return `${service}|${metric}`;
}

class MemoryStore implements StatStore {
  readonly name = 'memory';
  private counts = new Map<string, Map<Field, number>>();
  private visits = new Map<string, number>();
  private meta = new Map<string, string>();

  async addDeltas(deltas: Delta[]) {
    for (const d of deltas) {
      const bucketKey = `${d.bucket}|${d.period}`;
      let bucket = this.counts.get(bucketKey);
      if (!bucket) this.counts.set(bucketKey, (bucket = new Map()));
      bucket.set(d.field, (bucket.get(d.field) ?? 0) + d.value);
    }
  }

  async readBucket(bucket: Bucket, period: string) {
    return new Map(this.counts.get(`${bucket}|${period}`) ?? []);
  }

  async readMeta(key: string) {
    return this.meta.get(key) ?? null;
  }

  async writeMeta(key: string, value: string) {
    this.meta.set(key, value);
  }

  async purgeDayArchive(cutoff: string) {
    let removed = 0;
    for (const bucketKey of [...this.counts.keys()]) {
      const [bucket, period] = bucketKey.split('|');
      if (bucket !== 'd' || !DAY_RE.test(period) || period >= cutoff) continue;
      this.counts.delete(bucketKey);
      removed++;
    }
    return removed;
  }

  async getVisit(hash: string, period: string) {
    return this.visits.get(`${hash}|${period}`) ?? null;
  }

  async saveVisit(hash: string, period: string, at: number) {
    this.visits.set(`${hash}|${period}`, at);
  }
}

// Deno KV：一个「桶+周期+服务+指标」一个计数器键，写入是服务端原子自增
// 键尾保留分片段（默认 1 片），读侧按前缀合并，写竞争激烈时加片摊薄
class KvStore implements StatStore {
  readonly name = 'kv';
  private kv: any;
  private shards: number;

  constructor(kv: any, shards = 1) {
    this.kv = kv;
    this.shards = Math.max(1, shards);
  }

  private keyOf(bucket: Bucket, period: string, field: Field): string[] {
    const [service, metric] = field.split('|');
    const shard = String(Math.floor(Math.random() * this.shards));
    return ['st', bucket, period, service, metric, shard];
  }

  private static chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  async addDeltas(deltas: Delta[]) {
    const KvU64 = (globalThis as any).Deno?.KvU64;
    if (!KvU64) return;

    for (const group of KvStore.chunk(deltas, 200)) {
      // 同键合并，避免一个事务内对同一键重复 sum
      const merged = new Map<string, { key: string[]; value: bigint }>();
      for (const d of group) {
        const key = this.keyOf(d.bucket, d.period, d.field);
        const id = key.join('/');
        const value = BigInt(Math.round(d.value));
        const prev = merged.get(id);
        merged.set(id, prev ? { key: prev.key, value: prev.value + value } : { key, value });
      }

      const tx = this.kv.atomic();
      for (const { key, value } of merged.values()) {
        tx.mutate({ type: 'sum', key, value: new KvU64(value) });
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        if ((await tx.commit()).ok) break;
        if (attempt === 2) {
          console.warn('KV sum commit failed after retries:', merged.size, 'counters lost');
        }
      }
    }
  }

  private async collect(it: AsyncIterable<any>): Promise<Map<Field, number>> {
    const out = new Map<Field, number>();
    for await (const entry of it) {
      if (entry.value === null) continue;
      // key = ['st', bucket, period, service, metric, shard]
      const field = (entry.key as string[]).slice(3, 5).join('|');
      const value = Number(entry.value?.value ?? entry.value);
      out.set(field, (out.get(field) ?? 0) + value);
    }
    return out;
  }

  async readBucket(bucket: Bucket, period: string) {
    return this.collect(this.kv.list({ prefix: ['st', bucket, period] }));
  }

  async readMeta(key: string) {
    const res = await this.kv.get(['meta', key]);
    return (res.value as string) ?? null;
  }

  async writeMeta(key: string, value: string) {
    await this.kv.set(['meta', key], value, { expireIn: META_TTL });
  }

  async purgeDayArchive(cutoff: string) {
    const stale: string[][] = [];
    for await (const entry of this.kv.list({ prefix: ['st', 'd'] })) {
      const key = entry.key as string[];
      const period = key[2];
      if (typeof period === 'string' && DAY_RE.test(period) && period < cutoff) {
        stale.push(key);
      }
    }
    for (const group of KvStore.chunk(stale, 200)) {
      const tx = this.kv.atomic();
      for (const key of group) tx.mutate({ type: 'delete', key });
      if (!(await tx.commit()).ok) {
        console.warn('KV purge commit failed:', group.length, 'counters kept');
      }
    }
    return stale.length;
  }

  async getVisit(hash: string, period: string) {
    const res = await this.kv.get(['v', hash, period]);
    return (res.value as number) ?? null;
  }

  async saveVisit(hash: string, period: string, at: number) {
    await this.kv.set(['v', hash, period], at, { expireIn: VISIT_TTL });
  }
}

function env(key: string): string {
  try {
    const deno = (globalThis as any).Deno;
    if (deno?.env?.get) return deno.env.get(key) ?? '';
    return process.env[key] ?? '';
  } catch {
    return '';
  }
}

// 缓冲阈值：够大以守住 KV 写入额度，够小以保证看板近实时
const FLUSH_REQUESTS = parseInt(env('STATS_FLUSH_REQUESTS') || '200', 10);
const FLUSH_INTERVAL = parseInt(env('STATS_FLUSH_INTERVAL_MS') || '120000', 10);
const SHARDS = parseInt(env('STATS_SHARDS') || '1', 10);
// 按天存档保留天数：日桶超过这个天数即被清扫，键总量因此有上界
const RETENTION_DAYS = Math.max(1, parseInt(env('STATS_RETENTION_DAYS') || '180', 10));
const VISIT_TTL = 36 * 60 * 60 * 1000;
const META_TTL = 30 * DAY_MS;
const READ_CACHE_TTL = 15 * 1000;

let activeStore: StatStore | null = null;
let storePromise: Promise<StatStore> | null = null;

async function getStore(): Promise<StatStore> {
  if (activeStore) return activeStore;
  if (!storePromise) {
    storePromise = (async () => {
      const deno = (globalThis as any).Deno;
      try {
        if (deno?.Kv && typeof deno.Kv.get === 'function') {
          return new KvStore(deno.Kv, SHARDS);
        }
        if (typeof deno?.openKv === 'function') {
          return new KvStore(await deno.openKv(), SHARDS);
        }
      } catch {}
      return new MemoryStore();
    })();
  }
  activeStore = await storePromise;
  return activeStore;
}

// 注入后端（测试与特殊部署用），传 null 恢复自动检测
export function setStore(store: StatStore | null): void {
  activeStore = store;
  storePromise = store ? Promise.resolve(store) : null;
  readCache = null;
  purgedCutoff = '';
}

type Acc = { req: number; use: number; bytes: number; err: number; ms: number; uv: number };
let pending = new Map<string, Delta>();
let pendingEvents = 0;
let pendingSince = Date.now();
let revision = 0;
let flushTail: Promise<void> = Promise.resolve();
let hooksInstalled = false;

function dayPeriod(at: number = Date.now()): string {
  return cnDay(at);
}

// 含今日在内的最近 N 个自然日，旧 -> 新（日固定 +08:00 无夏令时，直接按 24h 步进）
function recentDayPeriods(days: number): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(dayPeriod(now - i * DAY_MS));
  }
  return out;
}

let purgedCutoff = '';

// 清扫超期日桶：同一保留期内只做一次，KV 后端的标记键让多实例共用一份进度
export async function purgeExpiredDays(): Promise<void> {
  const cutoff = dayPeriod(Date.now() - RETENTION_DAYS * DAY_MS);
  if (cutoff === purgedCutoff) return;
  try {
    const store = await getStore();
    if ((await store.readMeta(PURGE_META)) === cutoff) {
      purgedCutoff = cutoff;
      return;
    }
    const removed = await store.purgeDayArchive(cutoff);
    await store.writeMeta(PURGE_META, cutoff);
    purgedCutoff = cutoff;
    if (removed) console.log(`stats: 清理 ${removed} 个超期日桶（早于 ${cutoff}）`);
  } catch (error) {
    console.error('Failed to purge stats day archive:', error);
  }
}

function bufferDelta(bucket: Bucket, period: string, field: Field, value: number) {
  if (!value) return;
  revision++;
  const id = `${bucket}|${period}|${field}`;
  const prev = pending.get(id);
  pending.set(id, prev ? { ...prev, value: prev.value + value } : { bucket, period, field, value });
}

async function writePending(): Promise<void> {
  const deltas = [...pending.values()];
  pending = new Map();
  pendingEvents = 0;
  pendingSince = Date.now();
  if (!deltas.length) return;
  try {
    await (await getStore()).addDeltas(deltas);
    // 有落库就说明这个实例在干活，顺带补一次超期日桶清扫（进程内每天最多一次）
    void purgeExpiredDays();
  } catch (error) {
    console.error('Failed to flush stats:', error);
  }
}

// 落库缓冲中的增量；读看板前调用可保证本实例数据一致
export function flush(): Promise<void> {
  if (!pending.size) return flushTail;
  flushTail = flushTail.then(writePending);
  return flushTail;
}

function installFlushHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const deno = (globalThis as any).Deno;
  try {
    // Deploy 空转前发 SIGINT 并给 5 秒宽限，抓紧最后一段增量
    if (typeof deno?.addSignalListener === 'function') {
      deno.addSignalListener('SIGINT', () => {
        void flush();
      });
    }
  } catch {}
  // 低流量时段没有请求来触发阈值，用定时器兜底
  setInterval(() => {
    if (Date.now() - pendingSince >= FLUSH_INTERVAL) {
      void flush().then(purgeExpiredDays);
    }
  }, FLUSH_INTERVAL).unref?.();
}

export function recordRequest(event: RequestEvent): void {
  installFlushHooks();
  const period = dayPeriod();
  const { service } = event;
  const add = (metric: Metric, value: number) => {
    const field = fieldOf(service, metric);
    bufferDelta('d', period, field, value);
    bufferDelta('c', ALL_TIME, field, value);
  };

  add('req', 1);
  if (event.usage) add('use', 1);
  add('bytes', Math.max(0, Math.round(event.bytes)));
  add('ms', Math.max(0, Math.round(event.durationMs)));
  if (event.status >= 400) add('err', 1);

  if (++pendingEvents >= FLUSH_REQUESTS || Date.now() - pendingSince >= FLUSH_INTERVAL) {
    void flush();
  }
}

async function visitorHash(ip: string, userAgent: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${ip}|${userAgent}`)
  );
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 页面浏览量 + 当日去重访客（KV 后端跨实例去重，键带 TTL 不再无限增长）
export async function trackPageView(ip: string, userAgent: string): Promise<void> {
  recordRequest({ service: 'site', bytes: 0, status: 200, durationMs: 0 });
  try {
    const store = await getStore();
    const period = dayPeriod();
    const hash = await visitorHash(ip, userAgent);
    if ((await store.getVisit(hash, period)) !== null) return;
    await store.saveVisit(hash, period, Date.now());
    const field = fieldOf('site', 'uv');
    bufferDelta('d', period, field, 1);
    bufferDelta('c', ALL_TIME, field, 1);
  } catch (error) {
    console.error('Failed to track page view:', error);
  }
}

export type ServiceStat = {
  requests: number;
  // 使用次数：一次下载/拉取算一次（规则见 services.isUsageRequest）
  uses: number;
  bytes: number;
  errors: number;
  avgLatencyMs: number;
};
// 服务键由注册表推导：新增加速服务不必改这里
export type Snapshot = { pageViews: number; visitors: number } & {
  [K in Service]: ServiceStat;
};
export type Stats = {
  date: string;
  store: string;
  today: Snapshot;
  total: Snapshot;
};

function summarize(raw: Map<Field, number>): Snapshot {
  const byService = new Map<StatTarget, Acc>();
  for (const [field, value] of raw) {
    const [service, metric] = field.split('|');
    const acc = byService.get(service as StatTarget) ?? { req: 0, use: 0, bytes: 0, err: 0, ms: 0, uv: 0 };
    if (metric === 'req') acc.req += value;
    else if (metric === 'use') acc.use += value;
    else if (metric === 'bytes') acc.bytes += value;
    else if (metric === 'err') acc.err += value;
    else if (metric === 'ms') acc.ms += value;
    else if (metric === 'uv') acc.uv += value;
    byService.set(service as StatTarget, acc);
  }

  const stat = (service: StatTarget): ServiceStat => {
    const acc = byService.get(service);
    const req = acc?.req ?? 0;
    return {
      requests: req,
      uses: acc?.use ?? 0,
      bytes: acc?.bytes ?? 0,
      errors: acc?.err ?? 0,
      avgLatencyMs: req ? Math.round((acc!.ms / req) * 10) / 10 : 0,
    };
  };

  const services = Object.fromEntries(SERVICE_NAMES.map((name) => [name, stat(name)])) as Record<
    Service,
    ServiceStat
  >;

  return {
    ...services,
    pageViews: byService.get('site')?.req ?? 0,
    visitors: byService.get('site')?.uv ?? 0,
  };
}

let readCache: { at: number; revision: number; value: Stats } | null = null;

export async function getStats(): Promise<Stats> {
  await flush();
  const now = Date.now();
  // 只缓存跨实例读取：本实例一旦记账就作废，看板不会读到旧值
  if (readCache && readCache.revision === revision && now - readCache.at < READ_CACHE_TTL) {
    return readCache.value;
  }

  const store = await getStore();
  const period = dayPeriod();
  const [today, total] = await Promise.all([
    store.readBucket('d', period),
    store.readBucket('c', ALL_TIME),
  ]);

  const value: Stats = {
    date: period,
    store: store.name,
    today: summarize(today),
    total: summarize(total),
  };
  readCache = { at: now, revision, value };
  return value;
}

export async function storeName(): Promise<string> {
  return (await getStore()).name;
}

export type DaySnapshot = { date: string } & Snapshot;
export type DayArchive = {
  store: string;
  retentionDays: number;
  requestedDays: number;
  from: string;
  to: string;
  series: DaySnapshot[];
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

// 判定某天是否有数据：遍历快照里的所有服务，新增服务不必改这里
function hasTraffic(snapshot: Snapshot): boolean {
  return Object.entries(snapshot).some(([key, value]) =>
    key === 'pageViews' || key === 'visitors'
      ? (value as number) > 0
      : ((value as ServiceStat).requests ?? 0) > 0
  );
}

// 按天存档回看：只给到服务层级，空天（如上线前）不出现在结果里，今日始终保留
export async function getDayArchive(days: number = 30): Promise<DayArchive> {
  await flush();
  const store = await getStore();
  const requested = Math.max(1, Math.floor(days || 30));
  const capped = Math.min(requested, RETENTION_DAYS);
  const periods = recentDayPeriods(capped);
  const buckets = await mapLimit(periods, 8, (period) => store.readBucket('d', period));

  const today = periods[periods.length - 1];
  const series: DaySnapshot[] = [];
  periods.forEach((date, i) => {
    const snapshot = summarize(buckets[i]);
    if (hasTraffic(snapshot) || date === today) series.push({ date, ...snapshot });
  });

  return {
    store: store.name,
    retentionDays: RETENTION_DAYS,
    requestedDays: requested,
    from: periods[0],
    to: today,
    series,
  };
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatNumber(num: number): string {
  return Math.round(num).toLocaleString('zh-CN');
}
