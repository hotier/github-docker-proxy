// 日志和监控中间件
import { updateStats } from './stats';

interface LogEntry {
  timestamp: string;
  method: string;
  path: string;
  upstream?: string;
  status: number;
  bytes?: number;
  duration: number;
  ip: string;
  userAgent?: string;
  error?: string;
}

// 简单的控制台日志
export function logRequest(entry: LogEntry): void {
  const logLine = JSON.stringify(entry);
  console.log(logLine);
}

// 请求日志中间件
export async function withLogging(
  req: Request,
  handler: () => Promise<Response>
): Promise<Response> {
  const start = Date.now();
  const url = new URL(req.url);
  
  const clientIp = req.headers.get("x-forwarded-for") || 
                   req.headers.get("x-real-ip") || 
                   "unknown";
  
  try {
    const response = await handler();
    const duration = Date.now() - start;
    const bytes = parseInt(response.headers.get("content-length") || "0");
    
    // 更新指标
    updateMetrics(response.status, bytes, duration);
    
    // 更新统计数据（异步，不阻塞响应）
    updateStats(bytes).catch(err => console.error('Stats update failed:', err));
    
    logRequest({
      timestamp: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      status: response.status,
      bytes,
      duration,
      ip: clientIp,
      userAgent: req.headers.get("user-agent") || undefined
    });
    
    return response;
  } catch (error) {
    const duration = Date.now() - start;
    
    // 更新指标（错误）
    updateMetrics(500, 0, duration);
    
    logRequest({
      timestamp: new Date().toISOString(),
      method: req.method,
      path: url.pathname,
      status: 500,
      duration,
      ip: clientIp,
      userAgent: req.headers.get("user-agent") || undefined,
      error: error.message
    });
    
    throw error;
  }
}

// 性能指标收集
const metrics = {
  totalRequests: 0,
  totalErrors: 0,
  totalBytes: 0,
  averageDuration: 0,
  statusCounts: new Map<number, number>(),
};

export function updateMetrics(status: number, bytes: number, duration: number) {
  metrics.totalRequests++;
  if (status >= 400) metrics.totalErrors++;
  metrics.totalBytes += bytes;
  
  // 更新平均延迟（简单移动平均）
  metrics.averageDuration = (metrics.averageDuration * 0.9) + (duration * 0.1);
  
  // 状态码统计
  const count = metrics.statusCounts.get(status) || 0;
  metrics.statusCounts.set(status, count + 1);
}

export function getMetrics() {
  return {
    ...metrics,
    statusCounts: Object.fromEntries(metrics.statusCounts),
  };
}





