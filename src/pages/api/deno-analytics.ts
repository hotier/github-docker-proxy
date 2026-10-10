import type { APIRoute } from 'astro';
import { withLogging } from '../../lib/logging';
import { jsonResponse } from '../../lib/helpers';
import { cachedJson } from '../../lib/probe';
import { accumulateDailyRows, addUsage, dayOf, emptyUsage, type PlatformUsage } from '../../lib/platform-usage';
import { cnDayStart } from '../../lib/cn-date';

// 平台禁止自定义 DENO_ 前缀变量名，线上用 DEPLOY_ANALYTICS_TOKEN；本地 .env 沿用 DENO_API_TOKEN 保底
const DENO_API_TOKEN = process.env.DEPLOY_ANALYTICS_TOKEN || process.env.DENO_API_TOKEN;
const APP_NAME = 'github-docker-proxy';
const API_BASE = 'https://api.deno.com/v2';

// Deno Analytics 本身是 15 分钟粒度，服务端缓存 5 分钟足够，且免去每个访客一次外部 API 调用
const ANALYTICS_TTL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// 出网窗口只取最近 8 天：窗口内今天的桶用来算「今日」，最近几天用来幂等回填日桶，
// 更早的历史已经在 KV 归档里，不必每次刷新都重算。
// 实测有效窗口上限约 31 天（请求 35 天只回 2975 个桶 = 31 天差一个桶），文档没写这条限制，
// 所以更不能把「查得到多少」当「只查多少」——宽窗只是白烧 CPU：2975 行 × 每 5 分钟一次。
const LOOKBACK_DAYS = 8;

// 今日 = 东八区自然日；实例跑在 UTC，用本地零点会把翻页推迟到北京时间 08:00
function getTodayStart(): Date {
  return new Date(cnDayStart(Date.now()));
}

// 获取 ISO 格式时间（UTC）
function toISOUTC(date: Date): string {
  return date.toISOString();
}

async function fetchAnalytics(since: string, until: string): Promise<any> {
  const response = await fetch(
    `${API_BASE}/apps/${APP_NAME}/analytics?since=${since}&until=${until}`,
    {
      headers: {
        'Authorization': `Bearer ${DENO_API_TOKEN}`,
        'Accept': 'application/json'
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Deno API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

async function collectAnalytics(): Promise<unknown> {
  const until = toISOUTC(new Date());
  const todayStart = getTodayStart();
  const todaySince = toISOUTC(todayStart);
  const todayStartMs = todayStart.getTime();
  const since = toISOUTC(new Date(Date.now() - LOOKBACK_DAYS * DAY_MS));

  console.log('Fetching analytics from', since, 'to', until);

  // 平台没有承诺可查窗口的上限；宽窗口被拒时退回只查今天，
  // 这样「今日」和 KV 里已归档的历史日都不至于跟着一起挂掉
  let effectiveSince = since;
  let data: any;
  try {
    data = await fetchAnalytics(since, until);
  } catch (error) {
    console.warn('Wide analytics window failed, retrying with today only:', error);
    effectiveSince = todaySince;
    data = await fetchAnalytics(todaySince, until);
  }

  const fields = data.fields;
  const values = data.values;
  // 列下标按 fields[].name 取，官方文档说明未来可能插入新字段，位置不可依赖
  const col = Object.fromEntries((fields || []).map((field: any, index: number) => [field.name, index]));

  const today = emptyUsage();
  const days = new Map<string, PlatformUsage>();

  for (const row of values) {
    const time = row[col.time];
    if (typeof time !== 'string') continue;

    const usage: PlatformUsage = {
      requests: row[col.request_count] || 0,
      cpuMs: Math.round((row[col.cpu_seconds] || 0) * 1000),
      ingressBytes: row[col.network_ingress_bytes] || 0,
      egressBytes: row[col.network_egress_bytes] || 0
    };

    const day = dayOf(time);
    days.set(day, addUsage(days.get(day) ?? emptyUsage(), usage));
    if (new Date(time).getTime() >= todayStartMs) addUsage(today, usage);
  }

  // 累计读 KV 归档（当月日桶 + 已封存的月桶，含已超出出网窗口的更早日期），
  // 今日仍按东八区自然日从本次窗口算
  const rows = [...days].map(([day, usage]) => ({ day, usage }));
  const archived = await accumulateDailyRows(rows, { windowDays: LOOKBACK_DAYS });

  const latestValue = values[values.length - 1] || [];
  const latestData = {
    time: latestValue[col.time] ?? null,
    request_count: latestValue[col.request_count] || 0,
    cpu_seconds: latestValue[col.cpu_seconds] || 0,
    network_ingress_bytes: latestValue[col.network_ingress_bytes] || 0,
    network_egress_bytes: latestValue[col.network_egress_bytes] || 0
  };

  return {
    success: true,
    timeRange: {
      since: effectiveSince,
      until: until,
      todaySince: todaySince,
      // 日分割固定东八区，与实例时区无关
      timezone: 'Asia/Shanghai'
    },
    today: { ...usagePayload(today), dataPoints: values.length },
    total: {
      ...usagePayload(archived.total),
      // 归档覆盖的自然日数，用于判断累计值覆盖了多长的运行历史
      days: archived.days,
      store: archived.store,
      degraded: archived.degraded
    },
    latest: latestData,
    raw: {
      fields: fields,
      totalDataPoints: values.length
    }
  };
}

export const GET: APIRoute = async ({ request, url }) => {
  return withLogging(request, async () => {
    // 配置缺失直接返回，不占用缓存
    if (!DENO_API_TOKEN) {
      return jsonResponse({ success: false, error: 'DEPLOY_ANALYTICS_TOKEN is not configured' }, 503);
    }

    try {
      // 失败不入缓存（producer 抛错即不落地），下一个请求会重试
      // force 来自状态页刷新按钮：跳过 5 分钟缓存立刻回源，否则按钮名不副实
      return jsonResponse(
        await cachedJson('deno-analytics', ANALYTICS_TTL_MS, collectAnalytics, url.searchParams.has('force'))
      );
    } catch (error: any) {
      console.error('Deno Analytics API error:', error);
      return jsonResponse({ success: false, error: error.message }, 500);
    }
  });
};

// 今日与累计共用一套字段形状，前端按原始数值本地格式化才能跟着数字动画递增
function usagePayload(usage: PlatformUsage) {
  return {
    requests: usage.requests,
    cpuTime: Math.round(usage.cpuMs) / 1000,
    ingressBytes: usage.ingressBytes,
    egressBytes: usage.egressBytes,
    ingressFormatted: formatBytes(usage.ingressBytes),
    egressFormatted: formatBytes(usage.egressBytes)
  };
}

// 格式化字节数
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
