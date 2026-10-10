import type { APIRoute } from 'astro';
import { withLogging } from '../../../lib/logging';
import { jsonResponse } from '../../../lib/helpers';
import { probeService } from '../../../lib/probe';

// 单个上游的连通性探测（不统计到访问统计中），结果按实例缓存 PROBE_TTL_MS
// 状态页走批量端点 /api/status，这里留给外部监控按服务取一个
export const GET: APIRoute = async ({ request, params, url }) => {
  const service = params.service ?? '';
  const force = url.searchParams.has('force');

  return withLogging(request, async () => {
    const result = await probeService(service, force);
    return result ? jsonResponse(result) : jsonResponse({ error: 'Not Found', service }, 404);
  });
};
