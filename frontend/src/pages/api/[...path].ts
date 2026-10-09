import type { APIRoute } from 'astro';
import { proxyRequest, handleDockerProxy } from '../../lib/proxy';
import { checkRateLimit } from '../../lib/rate-limit';
import { withLogging } from '../../lib/logging';

const UPSTREAMS: Record<string, string> = {
  '/api/gh/': 'https://github.com',
  '/api/ghraw/': 'https://raw.githubusercontent.com',
  '/api/codeload/': 'https://codeload.github.com',
  '/api/objects/': 'https://objects.githubusercontent.com',
  '/api/release-assets/': 'https://release-assets.githubusercontent.com',
  '/api/api.github.com/': 'https://api.github.com',
  '/api/ghcr/': 'https://ghcr.io',
  '/api/gcr/': 'https://gcr.io',
  '/api/k8s/': 'https://registry.k8s.io',
  '/api/quay/': 'https://quay.io',
};

const DOCKER_HUB = 'https://registry-1.docker.io';
const DOCKER_AUTH = 'https://auth.docker.io';

export const ALL: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // 速率限制检查
  const rateLimitError = checkRateLimit(request);
  if (rateLimitError) return rateLimitError;
  
  // Docker Registry 代理（/v2/ 路径）
  if (path.startsWith('/v2/')) {
    return withLogging(request, () => 
      handleDockerProxy(request, path, url.search, DOCKER_HUB, DOCKER_AUTH)
    );
  }
  
  // GitHub 和其他代理
  for (const [prefix, upstream] of Object.entries(UPSTREAMS)) {
    if (path.startsWith(prefix)) {
      const targetPath = path.slice(prefix.length);
      return withLogging(request, () => 
        proxyRequest(request, upstream, targetPath, url.search)
      );
    }
  }
  
  return new Response(
    JSON.stringify({ error: 'Not Found', path }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
};
