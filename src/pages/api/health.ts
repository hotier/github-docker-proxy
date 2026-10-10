import type { APIRoute } from 'astro';
import { CONFIG } from '../../lib/config';
import { withLogging } from '../../lib/logging';
import { storeName } from '../../lib/stats';
import { getRateLimitStatus } from '../../lib/rate-limit';

export const GET: APIRoute = async ({ request }) => {
  return withLogging(request, async () => {
    const clientIp = request.headers.get('x-forwarded-for') || 
                     request.headers.get('x-real-ip') || 
                     'unknown';
    
    return new Response(
      JSON.stringify({
        status: 'ok',
        timestamp: Date.now(),
        version: CONFIG.VERSION,
        platform: 'Deno Deploy + Astro SSR',
        statsStore: await storeName(),
        rateLimit: CONFIG.RATE_LIMIT > 0 ? 'enabled' : 'disabled',
        rateLimitStatus: getRateLimitStatus(clientIp)
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
