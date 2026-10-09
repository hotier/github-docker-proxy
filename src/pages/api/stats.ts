import type { APIRoute } from 'astro';
import { getStats, formatBytes, formatNumber, trackMainVisit } from '../../lib/stats';
import { withLogging } from '../../lib/logging';

export const GET: APIRoute = async ({ request }) => {
  return withLogging(request, async () => {
    // 追踪 API 访问（用于状态页刷新）
    const clientIp = request.headers.get('x-forwarded-for') || 
                     request.headers.get('x-real-ip') || 
                     'unknown';
    const userAgent = request.headers.get('user-agent') || '';
    trackMainVisit(clientIp, userAgent, '/api/stats').catch(() => {});
    const stats = await getStats();
    
    return new Response(
      JSON.stringify({
        ...stats,
        formatted: {
          // 主站访问
          todayMainVisits: formatNumber(stats.today.mainVisits),
          todayMainVisitors: formatNumber(stats.today.mainVisitors),
          totalMainVisits: formatNumber(stats.total.mainVisits),
          totalMainVisitors: formatNumber(stats.total.mainVisitors),
          
          // GitHub 加速
          todayGithubRequests: formatNumber(stats.today.githubRequests),
          todayGithubBytes: formatBytes(stats.today.githubBytes),
          totalGithubRequests: formatNumber(stats.total.githubRequests),
          totalGithubBytes: formatBytes(stats.total.githubBytes),
          
          // Docker 加速
          todayDockerRequests: formatNumber(stats.today.dockerRequests),
          todayDockerBytes: formatBytes(stats.today.dockerBytes),
          totalDockerRequests: formatNumber(stats.total.dockerRequests),
          totalDockerBytes: formatBytes(stats.total.dockerBytes)
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

