import type { APIRoute } from 'astro';
import { withLogging } from '../../lib/logging';
import { jsonResponse } from '../../lib/helpers';
import { probeAllServices } from '../../lib/probe';

// 全部上游的连通性探测：状态页走合并端点 /api/dashboard，这里留给外部监控一次取齐
export const GET: APIRoute = async ({ request, url }) => {
  return withLogging(request, async () => {
    const services = await probeAllServices(url.searchParams.has('force'));
    return jsonResponse({ services, timestamp: Date.now() });
  });
};
