import type { APIRoute } from 'astro';
import { withLogging } from '../../lib/logging';
import { jsonResponse } from '../../lib/helpers';
import { probeAllServices } from '../../lib/probe';
import { getStats } from '../../lib/stats';
import { ANALYTICS_UNCONFIGURED, analyticsConfigured, loadAnalytics } from '../../lib/deno-analytics';

// 状态页一轮刷新原本要发三个请求（上游探测 / 本站统计 / 平台用量），每个请求都要过一次
// 中间件与路由，而免费额度按 CPU 时间计费；合并成一个请求后一轮只付一次。
// scope 决定服务端算哪几段：手动刷新只为本卡片付费。统计段两张卡片都要（表格里的请求流量
// 与访问统计同源），所以总是返回；探测段与用量段按 scope 省略。
// 三段各自的缓存（探测 PROBE_TTL_MS、用量 ANALYTICS_TTL_MS）仍然独立，多访客共享同一次回源。

export const GET: APIRoute = async ({ request, url }) => {
  return withLogging(request, async () => {
    const scope = url.searchParams.get('scope') ?? 'all';
    const force = url.searchParams.has('force');
    const generatedAt = Date.now();

    const [statsValue, servicesValue, analyticsValue] = await Promise.all([
      getStats(),
      scope !== 'stats' ? probeAllServices(force) : null,
      scope !== 'services' ? analyticsSection(force) : null,
    ]);

    const payload: Record<string, unknown> = { generatedAt, scope, stats: { ...statsValue, generatedAt } };
    if (servicesValue) payload.services = servicesValue;
    if (analyticsValue) payload.analytics = analyticsValue;

    return jsonResponse(payload);
  });
};

// 用量段失败不牵连整张看板：前端按 success=false 提示，其余卡片照常渲染
async function analyticsSection(force: boolean): Promise<unknown> {
  if (!analyticsConfigured()) return ANALYTICS_UNCONFIGURED;
  try {
    return await loadAnalytics(force);
  } catch (error: any) {
    console.error('Deno Analytics API error:', error);
    return { success: false, error: error.message };
  }
}
