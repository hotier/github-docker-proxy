import type { APIRoute } from 'astro';
import { CONFIG } from '../../lib/config';
import { getMetrics } from '../../lib/logging';
import { getRateLimitStatus } from '../../lib/rate-limit';

export const GET: APIRoute = async ({ request }) => {
  const clientIp = request.headers.get('x-forwarded-for') || 
                   request.headers.get('x-real-ip') || 
                   'unknown';
  
  return new Response(
    JSON.stringify({
      status: 'ok',
      timestamp: Date.now(),
      version: CONFIG.VERSION,
      platform: 'Deno Deploy + Astro SSR',
      rateLimit: CONFIG.RATE_LIMIT > 0 ? 'enabled' : 'disabled',
      rateLimitStatus: getRateLimitStatus(clientIp),
      metrics: getMetrics()
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );
};
