import type { APIRoute } from 'astro';
import { withLogging } from '../../lib/logging';
import { jsonResponse } from '../../lib/helpers';
import { ANALYTICS_UNCONFIGURED, analyticsConfigured, loadAnalytics } from '../../lib/deno-analytics';

// 平台用量单端点：取数与缓存都在 src/lib/deno-analytics.ts，状态页走的是合并端点 /api/dashboard
export const GET: APIRoute = async ({ request, url }) => {
  return withLogging(request, async () => {
    if (!analyticsConfigured()) {
      return jsonResponse(ANALYTICS_UNCONFIGURED, 503);
    }

    try {
      // force 来自状态页刷新按钮：跳过缓存立刻回源，否则按钮名不副实
      // 失败不入缓存（producer 抛错即不落地），下一个请求会重试
      const payload = await loadAnalytics(url.searchParams.has('force'), url.searchParams.has('debug'));
      return jsonResponse(payload);
    } catch (error: any) {
      console.error('Deno Analytics API error:', error);
      return jsonResponse({ success: false, error: error.message }, 500);
    }
  });
};
