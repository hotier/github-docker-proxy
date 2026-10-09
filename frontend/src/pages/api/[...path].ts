import type { APIRoute } from 'astro';

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

export const ALL: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const path = url.pathname;
  
  for (const [prefix, upstream] of Object.entries(UPSTREAMS)) {
    if (path.startsWith(prefix)) {
      const targetPath = path.slice(prefix.length);
      const targetUrl = upstream + '/' + targetPath + url.search;
      
      try {
        const headers = new Headers(request.headers);
        headers.delete('host');
        headers.set('user-agent', 'github-docker-proxy/1.0');
        
        const resp = await fetch(targetUrl, {
          method: request.method,
          headers,
          body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
          redirect: 'manual',
        });
        
        if ([301, 302, 307, 308].includes(resp.status)) {
          const location = resp.headers.get('location');
          if (location) {
            const newResp = new Response(null, { status: resp.status });
            newResp.headers.set('location', location);
            return newResp;
          }
        }
        
        return new Response(resp.body, {
          status: resp.status,
          headers: resp.headers
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: 'Proxy Error', message: error.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
  }
  
  return new Response(
    JSON.stringify({ error: 'Not Found', path }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
};
