import type { APIRoute } from 'astro';
import { withLogging } from '../../lib/logging';
import { jsonResponse } from '../../lib/helpers';
import { cachedJson } from '../../lib/probe';

const DENO_API_TOKEN = process.env.DENO_API_TOKEN;
const APP_NAME = 'github-docker-proxy';

// Deno Analytics 本身是 15 分钟粒度，服务端缓存 5 分钟足够，且免去每个访客一次外部 API 调用
const ANALYTICS_TTL_MS = 5 * 60 * 1000;

// 获取今日开始时间（本地时区）
function getTodayStart(): Date {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return today;
}

// 获取 ISO 格式时间（UTC）
function toISOUTC(date: Date): string {
  return date.toISOString();
}

async function collectAnalytics(): Promise<unknown> {
  const since = toISOUTC(getTodayStart());
  const until = toISOUTC(new Date());

  console.log('Fetching analytics from', since, 'to', until);

  const response = await fetch(
    `https://api.deno.com/v2/apps/${APP_NAME}/analytics?since=${since}&until=${until}`,
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

  const data = await response.json();
  const fields = data.fields;
  const values = data.values;

  let totalRequests = 0;
  let totalIngress = 0;
  let totalEgress = 0;
  let totalCpuTime = 0;

  for (const row of values) {
    totalRequests += row[1] || 0; // request_count
    totalCpuTime += row[2] || 0; // cpu_seconds
    totalIngress += row[5] || 0; // network_ingress_bytes
    totalEgress += row[6] || 0; // network_egress_bytes
  }

  const latestValue = values[values.length - 1] || [];
  const latestData = {
    time: latestValue[0] || null,
    request_count: latestValue[1] || 0,
    cpu_seconds: latestValue[2] || 0,
    network_ingress_bytes: latestValue[5] || 0,
    network_egress_bytes: latestValue[6] || 0
  };

  return {
    success: true,
    timeRange: {
      since: since,
      until: until,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    today: {
      requests: totalRequests,
      cpuTime: Math.round(totalCpuTime * 100) / 100,
      ingressBytes: totalIngress,
      egressBytes: totalEgress,
      ingressFormatted: formatBytes(totalIngress),
      egressFormatted: formatBytes(totalEgress),
      dataPoints: values.length
    },
    latest: latestData,
    raw: {
      fields: fields,
      totalDataPoints: values.length
    }
  };
}

export const GET: APIRoute = async ({ request }) => {
  return withLogging(request, async () => {
    // 配置缺失直接返回，不占用缓存
    if (!DENO_API_TOKEN) {
      return jsonResponse({ success: false, error: 'DENO_API_TOKEN is not configured' }, 503);
    }

    try {
      // 失败不入缓存（producer 抛错即不落地），下一个请求会重试
      return jsonResponse(await cachedJson('deno-analytics', ANALYTICS_TTL_MS, collectAnalytics));
    } catch (error: any) {
      console.error('Deno Analytics API error:', error);
      return jsonResponse({ success: false, error: error.message }, 500);
    }
  });
};

// 格式化字节数
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
