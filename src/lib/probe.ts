// 上游探测与其结果缓存。缓存是单实例进程内状态（与限流同口径），
// 作用是让同一实例上的多个访客共享一次出网探测，而不是每人刷新都打上游

import type { Service } from './services.ts';

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

// TTL 要大于看板的到期轮询(120s)，否则每一轮都打穿缓存：150s 下同一实例每 4 分钟才真发一轮上游探测
// 探测看的是连通性，滞后几分钟不影响判断；手动刷新按钮带 force 直接绕过缓存取实时值
export const PROBE_TTL_MS = 150_000;

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

// 每个服务的连通性探测目标。类型是 Record<Service, …>：注册表(src/lib/services)新增服务时
// 必须在这里补探测，状态页也不必再维护第二份服务清单
// 探测只发 HEAD 或小 GET，未带 token 的 registry 按协议回 401，同样说明连通
export const PROBES: Record<Service, ProbeTarget> = {
  github: {
    url: 'https://api.github.com/zen',
    method: 'GET',
    headers: { 'user-agent': 'github-docker-proxy-status-check' },
  },
  docker: { url: 'https://registry-1.docker.io/v2/', method: 'GET', ok: [200, 401] },
  npm: { url: 'https://registry.npmjs.org/mime', ok: [200] },
  go: { url: 'https://proxy.golang.org/github.com/gorilla/mux/@v/list', ok: [200] },
  jsd: { url: 'https://cdn.jsdelivr.net/npm/mime/package.json', ok: [200] },
  // 未指定版本时 unpkg 先 302 到具体版本
  unpkg: { url: 'https://unpkg.com/mime/package.json', ok: [200, 302] },
  maven: { url: 'https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom', ok: [200] },
  mcr: { url: 'https://mcr.microsoft.com/v2/', ok: [200, 401] },
  pypi: { url: 'https://pypi.org/simple/pip/', ok: [200] },
};

// 单个服务的探测结果，按服务名共享 PROBE_TTL_MS 缓存（批量端点与单服务端点同一份缓存）
// 未知服务名返回 null，由调用方给 404
export function probeService(
  service: string,
  force = false
): Promise<ProbeResult | null> {
  const target = Object.hasOwn(PROBES, service) ? PROBES[service as Service] : null;
  if (!target) return Promise.resolve(null);
  return cachedJson(
    'status:' + service,
    PROBE_TTL_MS,
    () => probeUpstream(target),
    force
  ) as Promise<ProbeResult>;
}
