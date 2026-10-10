import type { APIRoute } from 'astro';
import { withLogging } from '../../../lib/logging';
import { jsonResponse } from '../../../lib/helpers';
import { cachedJson, probeUpstream, PROBE_TTL_MS } from '../../../lib/probe';

// Docker Hub 连通性探测（不统计到访问统计中）
// registry 未带 token 时按协议返回 401，同样说明连通
export const GET: APIRoute = async ({ request, url }) => {
  return withLogging(request, async () => {
    const result = await cachedJson(
      'status:docker',
      PROBE_TTL_MS,
      () => probeUpstream({ url: 'https://registry-1.docker.io/v2/', method: 'GET', ok: [200, 401] }),
      url.searchParams.has('force')
    );

    return jsonResponse(result);
  });
};
