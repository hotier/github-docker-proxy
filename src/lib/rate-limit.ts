// 速率限制中间件（使用 Deno KV）

import { CONFIG } from "./config";

// 简单的内存速率限制器（生产环境建议用 Deno KV）
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

export function checkRateLimit(req: Request): Response | null {
  if (CONFIG.RATE_LIMIT <= 0) return null; // 未启用
  
  const clientIp = req.headers.get("x-forwarded-for") || 
                   req.headers.get("x-real-ip") || 
                   "unknown";
  
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 分钟窗口
  
  const record = rateLimitMap.get(clientIp);
  
  if (!record || now > record.resetTime) {
    // 新窗口
    rateLimitMap.set(clientIp, { count: 1, resetTime: now + windowMs });
    installSweeper();
    return null;
  }
  
  if (record.count >= CONFIG.RATE_LIMIT) {
    // 超过限制
    return new Response(JSON.stringify({
      error: "Too Many Requests",
      message: `Rate limit exceeded: ${CONFIG.RATE_LIMIT} requests per minute`,
      retryAfter: Math.ceil((record.resetTime - now) / 1000)
    }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": Math.ceil((record.resetTime - now) / 1000).toString()
      }
    });
  }
  
  // 增加计数
  record.count++;
  return null;
}

// 过期记录清扫：首次真正记账才装定时器，且 unref 不拖着事件循环不放
// （与 lib/stats.ts 的 flush 定时器同口径；未启用限流时这里一次都不会装）
let sweeperInstalled = false;
function installSweeper(): void {
  if (sweeperInstalled) return;
  sweeperInstalled = true;
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rateLimitMap.entries()) {
      if (now > value.resetTime) {
        rateLimitMap.delete(key);
      }
    }
  }, 60 * 1000).unref?.(); // 每分钟清理一次
}

// 获取速率限制状态（用于监控）
export function getRateLimitStatus(clientIp: string): { limit: number; remaining: number; resetTime: number } {
  const record = rateLimitMap.get(clientIp);
  const now = Date.now();
  
  if (!record || now > record.resetTime) {
    return {
      limit: CONFIG.RATE_LIMIT,
      remaining: CONFIG.RATE_LIMIT,
      resetTime: now + 60 * 1000
    };
  }
  
  return {
    limit: CONFIG.RATE_LIMIT,
    remaining: Math.max(0, CONFIG.RATE_LIMIT - record.count),
    resetTime: record.resetTime
  };
}



