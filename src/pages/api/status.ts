import type { APIRoute } from 'astro';
import { withLogging } from '../../lib/logging';
import { jsonResponse } from '../../lib/helpers';
import { probeService } from '../../lib/probe';
import { SERVICE_NAMES } from '../../lib/services';

// 全部上游的连通性探测，一次请求喂满状态页的服务节点列表：
// 逐个服务取要 9 个请求，每个请求都要过一次中间件与路由，而免费额度按 CPU 时间计
// 各服务结果仍按 src/lib/probe.ts 的 PROBE_TTL_MS 独立缓存，与单服务端点共用同一份
export const GET: APIRoute = async ({ request, url }) => {
  return withLogging(request, async () => {
    const force = url.searchParams.has('force');
    const services = Object.fromEntries(
      await Promise.all(
        SERVICE_NAMES.map(async (service) => [service, await probeService(service, force)])
      )
    );
    return jsonResponse({ services, timestamp: Date.now() });
  });
};
