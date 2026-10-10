// Astro 中间件注册点必须是 src/middleware.ts
import { defineMiddleware } from 'astro/middleware';
import { recordRequest, trackPageView } from './lib/stats';
import { serviceOf } from './lib/services';
import { checkAuth, countOutboundBytes } from './lib/helpers';

const MAIN_PAGES = new Set(['/', '/github', '/docker', '/packages', '/status']);

function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for') ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { request } = context;
  const path = context.url.pathname;
  // 分类与路由同源(src/lib/services)，杜绝「能代理但不计数/不鉴权」的漏网前缀
  const service = serviceOf(path);

  if (service) {
    // 代理请求鉴权(未设置 PROXY_PASSWORD 时直接放行)
    const authError = checkAuth(request);
    if (authError) return authError;

    const start = Date.now();
    const proxied = await next();
    const durationMs = Date.now() - start;

    // 响应体是透传流，字节数在流结束后才确定，此时再记账
    const { response, settled } = countOutboundBytes(proxied);
    settled.then((bytes) => {
      recordRequest({ service, bytes, status: proxied.status, durationMs });
    });

    return response;
  }

  if (MAIN_PAGES.has(path)) {
    // 只统计页面访问：API 与静态资源不计入，避免状态页轮询自我放大
    void trackPageView(clientIp(request), request.headers.get('user-agent') || '');
  }

  return next();
});
