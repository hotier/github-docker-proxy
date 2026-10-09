import type { APIRoute } from 'astro';
import { getStats, formatBytes, formatNumber } from '../../lib/stats';
import { withLogging } from '../../lib/logging';

export const GET: APIRoute = async ({ request }) => {
  return withLogging(request, async () => {
    const stats = await getStats();
    
    // 安全地获取数值
    const githubTodayReq = stats?.today?.github?.requests || 0;
    const githubTodayByt = stats?.today?.github?.bytes || 0;
    const githubTotalReq = stats?.total?.github?.requests || 0;
    const githubTotalByt = stats?.total?.github?.bytes || 0;
    
    const dockerTodayReq = stats?.today?.docker?.requests || 0;
    const dockerTodayByt = stats?.today?.docker?.bytes || 0;
    const dockerTotalReq = stats?.total?.docker?.requests || 0;
    const dockerTotalByt = stats?.total?.docker?.bytes || 0;
    
    const totalTodayReq = githubTodayReq + dockerTodayReq;
    const totalTodayByt = githubTodayByt + dockerTodayByt;
    const totalReq = githubTotalReq + dockerTotalReq;
    const totalByt = githubTotalByt + dockerTotalByt;
    
    return new Response(
      JSON.stringify({
        ...stats,
        formatted: {
          githubTodayRequests: formatNumber(githubTodayReq),
          githubTodayBytes: formatBytes(githubTodayByt),
          githubTotalRequests: formatNumber(githubTotalReq),
          githubTotalBytes: formatBytes(githubTotalByt),
          dockerTodayRequests: formatNumber(dockerTodayReq),
          dockerTodayBytes: formatBytes(dockerTodayByt),
          dockerTotalRequests: formatNumber(dockerTotalReq),
          dockerTotalBytes: formatBytes(dockerTotalByt),
          totalTodayRequests: formatNumber(totalTodayReq),
          totalTodayBytes: formatBytes(totalTodayByt),
          totalRequests: formatNumber(totalReq),
          totalBytes: formatBytes(totalByt)
        }
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  });
};
