import type { APIRoute } from 'astro';
import { getDayArchive } from '../../../lib/stats';
import { withLogging } from '../../../lib/logging';
import { jsonResponse } from '../../../lib/helpers';

// 按天存档回看：GET /api/stats/history?days=30
export const GET: APIRoute = async ({ request }) => {
  return withLogging(request, async () => {
    const days = new URL(request.url).searchParams.get('days');
    const archive = await getDayArchive(days ? parseInt(days, 10) : 30);
    return jsonResponse({ ...archive, generatedAt: Date.now() });
  });
};
