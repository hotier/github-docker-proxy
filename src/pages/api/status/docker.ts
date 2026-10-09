import type { APIRoute } from 'astro';
import { withLogging } from '../../lib/logging';

// 模拟 Docker 状态检查（不统计到访问统计中）
export const GET: APIRoute = async ({ request }) => {
  return withLogging(request, async () => {
    const start = Date.now();
    
    try {
      // 尝试访问 Docker Hub API
      const response = await fetch('https://registry-1.docker.io/v2/', {
        method: 'GET'
      });
      
      const duration = Date.now() - start;
      
      // Docker Registry 返回 401 是正常的（需要认证）
      const isOk = response.ok || response.status === 401;
      
      return new Response(
        JSON.stringify({
          status: isOk ? 'ok' : 'error',
          responseTime: duration,
          statusCode: response.status,
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
