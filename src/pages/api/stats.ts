import type { APIRoute } from 'astro';
import { getStats } from '../../lib/stats';
import { withLogging } from '../../lib/logging';
import { jsonResponse } from '../../lib/helpers';

export const GET: APIRoute = async ({ request }) => {
  return withLogging(request, async () => {
    const stats = await getStats();
    return jsonResponse({ ...stats, generatedAt: Date.now() });
  });
};
