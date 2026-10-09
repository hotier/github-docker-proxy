import type { APIRoute } from 'astro';
import { withLogging } from '../../lib/logging';

// 模拟 GitHub 状态检查（不统计到访问统计中）
export const GET: APIRoute = async ({ request }) => {
  return withLogging(request, async () => {
    const start = Date.now();
    
    try {
      // 尝试访问 GitHub API
      const response = await fetch('https://api.github.com/zen', {
        method: 'GET',
        headers: {
          'User-Agent': 'github-docker-proxy-status-check'
        }
      });
      
      const duration = Date.now() - start;
      
      return new Response(
        JSON.stringify({
          status: response.ok ? 'ok' : 'error',
          responseTime: duration,
          timestamp: Date.now()
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          status: 'error',
          responseTime: Date.now() - start,
          error: error.message,
          timestamp: Date.now()
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  });
};
