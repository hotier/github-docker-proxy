import type { APIRoute } from 'astro';
import { getStats, formatBytes, formatNumber } from '../../lib/stats';
import { withLogging } from '../../lib/logging';

export const GET: APIRoute = async ({ request }) => {
  return withLogging(request, async () => {
    const stats = await getStats();
    
    return new Response(
      JSON.stringify({
        ...stats,
        formatted: {
          totalRequests: formatNumber(stats.total.requests),
          totalBytes: formatBytes(stats.total.bytes),
          todayRequests: formatNumber(stats.today.requests),
          todayBytes: formatBytes(stats.today.bytes)
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
