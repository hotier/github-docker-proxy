import type { APIRoute } from 'astro';
import { getMetrics, withLogging } from '../../lib/logging';

export const GET: APIRoute = async ({ request }) => {
  return withLogging(request, async () => {
    return new Response(
      JSON.stringify(getMetrics()),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  });
};
