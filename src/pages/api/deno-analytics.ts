import type { APIRoute } from 'astro';
import { withLogging } from '../../lib/logging';

const DENO_API_TOKEN = process.env.DENO_API_TOKEN || 'ddo_HAY9UXNCYjpHDrKKQvBfBJuHFTyehEnr4qcs';
const APP_NAME = 'github-docker-proxy';

interface AnalyticsData {
  time: string;
  request_count: number;
  cpu_seconds: number;
  runtime_seconds: number;
  memory_time_byte_seconds: number;
  network_ingress_bytes: number;
  network_egress_bytes: number;
  kv_read_units: number;
  kv_write_units: number;
}

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

export const GET: APIRoute = async ({ request }) => {
  return withLogging(request, async () => {
    try {
      // 计算今日时间范围（本地时区）
      const todayStart = getTodayStart();
      const now = new Date();
      
      // 转换为 UTC 时间字符串
      const since = toISOUTC(todayStart);
      const until = toISOUTC(now);
      
      console.log('Fetching analytics from', since, 'to', until);
      
      // 调用 Deno Deploy Analytics API
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
      
      // 解析数据
      const fields = data.fields;
      const values = data.values;
      
      // 计算今日汇总数据
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
      
      // 获取最近的时间点数据
      const latestValue = values[values.length - 1] || [];
      const latestData = {
        time: latestValue[0] || null,
        request_count: latestValue[1] || 0,
        cpu_seconds: latestValue[2] || 0,
        network_ingress_bytes: latestValue[5] || 0,
        network_egress_bytes: latestValue[6] || 0
      };

      return new Response(
        JSON.stringify({
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
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    } catch (error) {
      console.error('Deno Analytics API error:', error);
      return new Response(
        JSON.stringify({
          success: false,
          error: error.message
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
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
