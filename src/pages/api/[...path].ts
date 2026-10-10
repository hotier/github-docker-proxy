import type { APIRoute } from 'astro';
import { proxyRequest } from '../../lib/proxy';
import { findApiRoute } from '../../lib/services';
import { checkRateLimit } from '../../lib/rate-limit';
import { withLogging } from '../../lib/logging';

export const ALL: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // 速率限制检查
  const rateLimitError = checkRateLimit(request);
  if (rateLimitError) return rateLimitError;
  
  // Go 校验和数据库:go 命令配置 GOPROXY 后经 {proxy}/sumdb/sum.golang.org/... 查询
  // 需剥掉 /sumdb/sum.golang.org 前缀转发到 sum.golang.org,放在 /api/goproxy/ 通配之前
  const SUMDB_PREFIX = '/api/goproxy/sumdb/sum.golang.org/';
  if (path.startsWith(SUMDB_PREFIX)) {
    const targetPath = path.slice(SUMDB_PREFIX.length);
    return withLogging(request, () =>
      proxyRequest(request, 'https://sum.golang.org', targetPath, url.search)
    );
  }

  // 前缀 -> 上游来自统一注册表(src/lib/services)
  const route = findApiRoute(path);
  if (route) {
    const targetPath = path.slice(route.prefix.length);
    return withLogging(request, () => 
      proxyRequest(request, route.upstream, targetPath, url.search)
    );
  }
  
  return new Response(
    JSON.stringify({ error: 'Not Found', path }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
};
