import { defineMiddleware } from 'astro/middleware';
import { trackMainVisit, trackProxyRequest } from '../lib/stats';

// 判断是否是主站页面访问
function isMainPageVisit(path: string): boolean {
  return (
    path === '/' ||
    path === '/index.html' ||
    path === '/github' ||
    path === '/docker' ||
    path === '/status'
  );
}

// 判断是否是代理请求
function isProxyRequest(path: string): boolean {
  const excludePaths = [
    '/api/health',
    '/api/metrics',
    '/api/stats',
    '/api/ratelimit',
    '/api/status/'
  ];
  
  if (excludePaths.some(exclude => path.startsWith(exclude))) {
    return false;
  }
  
  const githubPaths = [
    '/api/gh/',
    '/api/ghraw/',
    '/api/codeload/',
    '/api/objects/',
    '/api/release-assets/',
    '/api/api.github.com/'
  ];
  
  const dockerPaths = [
    '/v2/',
    '/api/ghcr/',
    '/api/gcr/',
    '/api/k8s/',
    '/api/quay/'
  ];
  
  return [...githubPaths, ...dockerPaths].some(prefix => path.startsWith(prefix));
}

// 判断代理服务类型
function getProxyService(path: string): 'github' | 'docker' | null {
  const githubPaths = [
    '/api/gh/',
    '/api/ghraw/',
    '/api/codeload/',
    '/api/objects/',
    '/api/release-assets/',
    '/api/api.github.com/'
  ];
  
  const dockerPaths = [
    '/v2/',
    '/api/ghcr/',
    '/api/gcr/',
    '/api/k8s/',
    '/api/quay/'
  ];
  
  if (githubPaths.some(prefix => path.startsWith(prefix))) {
    return 'github';
  }
  
  if (dockerPaths.some(prefix => path.startsWith(prefix))) {
    return 'docker';
  }
  
  return null;
}

export const onRequest = defineMiddleware(async (context, next) => {
  console.log('=== MIDDLEWARE EXECUTED ===');
  console.log('Path:', context.url.pathname);
  const { request, url } = context;
  const path = url.pathname;
  
  console.log('Middleware called for path:', path);
  
  const clientIp = request.headers.get('x-forwarded-for') || 
                   request.headers.get('x-real-ip') || 
                   'unknown';
  const userAgent = request.headers.get('user-agent') || '';
  
  // 统计主站访问
  if (isMainPageVisit(path)) {
    console.log('Tracking main page visit:', path);
    trackMainVisit(clientIp, userAgent, path).catch(err => 
      console.error('Visit tracking failed:', err)
    );
  }
  
  // 统计代理请求
  if (isProxyRequest(path)) {
    const service = getProxyService(path);
    if (service) {
      // 获取响应大小
      const response = await next();
      const bytes = parseInt(response.headers.get('content-length') || '0');
      
      trackProxyRequest(service, bytes).catch(err => 
        console.error('Proxy tracking failed:', err)
      );
      
      return response;
    }
  }
  
  return next();
});

