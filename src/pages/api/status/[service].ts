import type { APIRoute } from 'astro';
import { withLogging } from '../../../lib/logging';
import { jsonResponse } from '../../../lib/helpers';
import { cachedJson, probeUpstream, PROBE_TTL_MS, type ProbeTarget } from '../../../lib/probe';

// 新增服务的状态检查（npm / go / jsd / unpkg / maven / mcr / pypi），github、docker 保留各自的静态路由
// 探测只发 HEAD，结果按实例缓存 PROBE_TTL_MS，不统计到访问统计中
const PROBES: Record<string, ProbeTarget> = {
  npm: { url: 'https://registry.npmjs.org/mime', ok: [200] },
  go: { url: 'https://proxy.golang.org/github.com/gorilla/mux/@v/list', ok: [200] },
  jsd: { url: 'https://cdn.jsdelivr.net/npm/mime/package.json', ok: [200] },
  // 未指定版本时 unpkg 先 302 到具体版本
  unpkg: { url: 'https://unpkg.com/mime/package.json', ok: [200, 302] },
  maven: { url: 'https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom', ok: [200] },
  // registry 未带 token 时按协议返回 401，同样说明连通
  mcr: { url: 'https://mcr.microsoft.com/v2/', ok: [200, 401] },
  pypi: { url: 'https://pypi.org/simple/pip/', ok: [200] },
};

export const GET: APIRoute = async ({ request, params, url }) => {
  const service = params.service ?? '';
  const probe = PROBES[service];
  if (!probe) {
    return jsonResponse({ error: 'Not Found', service: params.service }, 404);
  }

  return withLogging(request, async () => {
    const result = await cachedJson(
      'status:' + service,
      PROBE_TTL_MS,
      () => probeUpstream(probe),
      url.searchParams.has('force')
    );

    return jsonResponse(result);
  });
};
