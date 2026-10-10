import type { APIRoute } from 'astro';
import { withLogging } from '../../../lib/logging';
import { jsonResponse } from '../../../lib/helpers';
import { cachedJson, probeUpstream, PROBE_TTL_MS } from '../../../lib/probe';

// GitHub 连通性探测（不统计到访问统计中），结果按实例缓存 PROBE_TTL_MS
export const GET: APIRoute = async ({ request, url }) => {
  return withLogging(request, async () => {
    const result = await cachedJson(
      'status:github',
      PROBE_TTL_MS,
      () => probeUpstream({
        url: 'https://api.github.com/zen',
        method: 'GET',
        headers: { 'user-agent': 'github-docker-proxy-status-check' },
      }),
      url.searchParams.has('force')
    );

    return jsonResponse(result);
  });
};
