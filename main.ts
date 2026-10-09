// GitHub & Docker Registry Proxy on Deno Deploy
// 免费额度：100万请求/天，128MB内存，无CPU时间限制

// 使用 Deno.serve() (Deno Deploy 标准方式)
// 支持本地开发：deno task dev 或 deno run --allow-net --allow-env main.ts

import { serveStatic } from "./src/utils/static.ts";
import { CONFIG } from "./src/config.ts";
import { proxyRequest, handleDockerProxy } from "./src/handlers/proxy.ts";
import { diagnosticEndpoint } from "./src/handlers/diag.ts";
import { jsonResponse, checkAuth } from "./src/utils/helpers.ts";
import { checkRateLimit, getRateLimitStatus } from "./src/middleware/rateLimit.ts";
import { withLogging, getMetrics } from "./src/middleware/logging.ts";

// ==================== 配置区 ====================

// 本地开发端口（Deno Deploy 会自动分配端口，本地默认 8000）
const PORT = parseInt(Deno.env.get("PORT") || "8000");

// 设置访问密码（可选），环境变量 PROXY_PASSWORD
// 设置后所有请求需要 Basic Auth: proxy:<password>

const UPSTREAMS: Record<string, string> = {
  // GitHub 相关
  "/gh/": "https://github.com",
  "/ghraw/": "https://raw.githubusercontent.com",
  "/codeload/": "https://codeload.github.com",
  "/objects/": "https://objects.githubusercontent.com",
  "/release-assets/": "https://release-assets.githubusercontent.com",
  "/api.github.com/": "https://api.github.com",
  "/avatars/": "https://avatars.githubusercontent.com",
  
  // Docker Registry 相关
  "/ghcr/": "https://ghcr.io",
  "/gcr/": "https://gcr.io",
  "/k8s/": "https://registry.k8s.io",
  "/quay/": "https://quay.io",
  "/docker.io/": "https://registry-1.docker.io",
  
  // 默认 Docker Hub（无路径前缀时）
  // "/v2/" 会自动匹配到 registry-1.docker.io
};

const DOCKER_HUB = "https://registry-1.docker.io";
const DOCKER_AUTH = "https://auth.docker.io";

// ==================== 主入口 ====================

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // 健康检查
  if (path === "/health") {
    return jsonResponse({ 
      status: "ok", 
      timestamp: Date.now(),
      version: CONFIG.VERSION,
      rateLimit: CONFIG.RATE_LIMIT > 0 ? "enabled" : "disabled"
    });
  }

  // 诊断端点：测试外部连接
  if (path === "/diag") {
    return await diagnosticEndpoint();
  }

  // 监控指标端点
  if (path === "/metrics") {
    return jsonResponse(getMetrics());
  }

  // 速率限制状态查询
  if (path === "/ratelimit") {
    const clientIp = req.headers.get("x-forwarded-for") || 
                     req.headers.get("x-real-ip") || 
                     "unknown";
    return jsonResponse(getRateLimitStatus(clientIp));
  }

  // 静态文件服务
  if (path === "/" || path === "/index.html") {
    return await serveStatic("static/index.html", "text/html; charset=utf-8");
  }
  
  if (path === "/style.css") {
    return await serveStatic("static/css/style.css", "text/css; charset=utf-8");
  }
  
  if (path === "/script.js") {
    return await serveStatic("static/js/script.js", "application/javascript; charset=utf-8");
  }

  // 鉴权检查
  const authError = checkAuth(req);
  if (authError) return authError;

  // 速率限制检查
  const rateLimitError = checkRateLimit(req);
  if (rateLimitError) return rateLimitError;

  // 处理 Docker Hub 的 /v2/ 路径（无前缀）
  if (path.startsWith("/v2/")) {
    return withLogging(req, () => handleDockerProxy(req, path, url.search, DOCKER_HUB, DOCKER_AUTH));
  }

  // 处理其他前缀
  for (const [prefix, upstream] of Object.entries(UPSTREAMS)) {
    if (path.startsWith(prefix)) {
      const targetPath = path.slice(prefix.length);
      // 确保 upstream 以 / 结尾，targetPath 不以 / 开头
      const normalizedUpstream = upstream.endsWith("/") ? upstream : upstream + "/";
      const normalizedPath = targetPath.startsWith("/") ? targetPath.slice(1) : targetPath;
      return withLogging(req, () => proxyRequest(req, normalizedUpstream, normalizedPath, url.search));
    }
  }

  return jsonResponse({ error: "Not Found", path }, 404);
});

// ==================== 启动信息 ====================

console.log(`🚀 GitHub & Docker Proxy v${CONFIG.VERSION}`);
console.log(`📡 Listening on http://localhost:${PORT}`);
console.log(`🌍 Environment: ${Deno.env.get("DENO_DEPLOYMENT_ID") ? "Deno Deploy" : "Local"}`);
console.log(`\n📋 Available endpoints:`);
console.log(`  /gh/*          → github.com`);
console.log(`  /ghraw/*       → raw.githubusercontent.com`);
console.log(`  /v2/*          → registry-1.docker.io`);
console.log(`  /ghcr/*        → ghcr.io`);
console.log(`  /health        → Health check`);
console.log(`  /diag          → Diagnostic tests`);
console.log(`\n💡 Tips:`);
console.log(`  - Press Ctrl+C to stop`);
console.log(`  - Set PORT env to change port (default: 8000)`);
console.log(`  - Set PROXY_PASSWORD env to enable auth\n`);

