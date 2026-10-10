// 上游探测与其结果缓存。缓存是单实例进程内状态（与限流同口径），
// 作用是让同一实例上的多个访客共享一次出网探测，而不是每人刷新都打上游

export type ProbeResult = {
  status: 'ok' | 'error';
  responseTime: number;
  statusCode?: number;
  error?: string;
  timestamp: number;
};

export type ProbeTarget = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  // 上游按协议返回非 2xx 也算连通时（如 registry 未带 token 的 401），用白名单判定
  ok?: number[];
};

type CacheEntry = { at: number; data: unknown };

// 看板每 60 秒回源一次，30 秒 TTL 既能合并同一时刻的并发刷新，又不至于让状态明显滞后
export const PROBE_TTL_MS = 30_000;

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<unknown>>();

// 结果先落地再入缓存：producer 抛错时不缓存，下个请求即重试
// 并发请求复用在途 promise，同一实例上同一 key 只发一次上游请求
// force（手动刷新按钮）跳过新鲜度检查，但并发 force 仍共享同一次探测
export async function cachedJson(
  key: string,
  ttlMs: number,
  producer: () => Promise<unknown>,
  force = false
): Promise<unknown> {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < ttlMs) return hit.data;

  const running = pending.get(key);
  if (running) return running;

  const task = producer()
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      pending.delete(key);
    });

  pending.set(key, task);
  return task;
}

export async function probeUpstream(target: ProbeTarget): Promise<ProbeResult> {
  const start = Date.now();

  try {
    const response = await fetch(target.url, {
      method: target.method ?? 'HEAD',
      headers: target.headers,
    });
    const isOk = target.ok ? target.ok.includes(response.status) : response.ok;

    return {
      status: isOk ? 'ok' : 'error',
      responseTime: Date.now() - start,
      statusCode: response.status,
      timestamp: Date.now(),
    };
  } catch (error: any) {
    return {
      status: 'error',
      responseTime: Date.now() - start,
      error: error.message,
      timestamp: Date.now(),
    };
  }
}
