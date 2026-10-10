// 请求日志中间件
// 指标统计统一由 src/lib/stats.ts 采集，这里只输出结构化日志行

interface LogEntry {
  timestamp: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  ip: string;
  userAgent?: string;
  error?: string;
}

function logRequest(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

function clientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for') ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

export async function withLogging(
  req: Request,
  handler: () => Promise<Response>
): Promise<Response> {
  const start = Date.now();
  const path = new URL(req.url).pathname;
  const userAgent = req.headers.get('user-agent') || '';

  try {
    const response = await handler();
    logRequest({
      timestamp: new Date().toISOString(),
      method: req.method,
      path,
      status: response.status,
      duration: Date.now() - start,
      ip: clientIp(req),
      userAgent
    });
    return response;
  } catch (error: any) {
    logRequest({
      timestamp: new Date().toISOString(),
      method: req.method,
      path,
      status: 500,
      duration: Date.now() - start,
      ip: clientIp(req),
      userAgent,
      error: error?.message
    });
    throw error;
  }
}
