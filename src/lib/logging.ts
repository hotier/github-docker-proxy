// 日志和监控中间件


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

// 判断是否是主站页面访问
function isMainPageVisit(path: string): boolean {
  // 只统计主站页面访问，不统计 API 和静态资源
  return (
    path === '/' ||
    path === '/index.html' ||
    path === '/github' ||
    path === '/docker' ||
    path === '/status'
  );
}

// 判断是否是代理请求
function isProxyRequest(path: string): boolean {
  // 排除的 API 路径
  const excludePaths = [
    '/api/health',
    '/api/metrics',
    '/api/stats',
    '/api/ratelimit',
    '/api/status/'
  ];
  
  // 检查是否在排除列表中
  if (excludePaths.some(exclude => path.startsWith(exclude))) {
    return false;
  }
  
  // GitHub 代理
  const githubPaths = [
    '/api/gh/',
    '/api/ghraw/',
    '/api/codeload/',
    '/api/objects/',
    '/api/release-assets/',
    '/api/api.github.com/'
  ];
  
  // Docker 代理
  const dockerPaths = [
    '/v2/',
    '/api/ghcr/',
    '/api/gcr/',
    '/api/k8s/',
    '/api/quay/'
  ];
  
  return [...githubPaths, ...dockerPaths].some(prefix => path.startsWith(prefix));
}

// 判断代理服务类型
function getProxyService(path: string): 'github' | 'docker' | null {
  const githubPaths = [
    '/api/gh/',
    '/api/ghraw/',
    '/api/codeload/',
    '/api/objects/',
    '/api/release-assets/',
    '/api/api.github.com/'
  ];
  
  const dockerPaths = [
    '/v2/',
    '/api/ghcr/',
    '/api/gcr/',
    '/api/k8s/',
    '/api/quay/'
  ];
  
  if (githubPaths.some(prefix => path.startsWith(prefix))) {
    return 'github';
  }
  
  if (dockerPaths.some(prefix => path.startsWith(prefix))) {
    return 'docker';
  }
  
  return null;
}

// 请求日志中间件
export async function withLogging(
  req: Request,
  handler: () => Promise<Response>
): Promise<Response> {
  const start = Date.now();
  const url = new URL(req.url);
  const path = url.pathname;
  
  const clientIp = req.headers.get("x-forwarded-for") || 
                   req.headers.get("x-real-ip") || 
                   "unknown";
  const userAgent = req.headers.get("user-agent") || "";
  
  try {
    const response = await handler();
    const duration = Date.now() - start;
    const bytes = parseInt(response.headers.get("content-length") || "0");
    
    // 更新指标
    updateMetrics(response.status, bytes, duration);
    

    logRequest({
      timestamp: new Date().toISOString(),
      method: req.method,
      path: path,
      status: response.status,
      bytes,
      duration,
      ip: clientIp,
      userAgent
    });
    
    return response;
  } catch (error) {
    const duration = Date.now() - start;
    
    // 更新指标（错误）
    updateMetrics(500, 0, duration);
    
    logRequest({
      timestamp: new Date().toISOString(),
      method: req.method,
      path: path,
      status: 500,
      duration,
      ip: clientIp,
      userAgent,
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


