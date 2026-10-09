// GitHub & Docker Registry Proxy on Deno Deploy
// 免费额度：100万请求/天，128MB内存，无CPU时间限制

// 使用 Deno.serve() (Deno Deploy 标准方式)
// 支持本地开发：deno task dev 或 deno run --allow-net --allow-env main.ts

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
    return jsonResponse({ status: "ok", timestamp: Date.now() });
  }

  // 诊断端点：测试外部连接
  if (path === "/diag") {
    return await diagnosticEndpoint();
  }

  // 首页
  if (path === "/" || path === "/index.html") {
    return new Response(INDEX_HTML, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  // 鉴权检查
  const authError = checkAuth(req);
  if (authError) return authError;

  // 处理 Docker Hub 的 /v2/ 路径（无前缀）
  if (path.startsWith("/v2/")) {
    return handleDockerProxy(req, path, url.search);
  }

  // 处理其他前缀
  for (const [prefix, upstream] of Object.entries(UPSTREAMS)) {
    if (path.startsWith(prefix)) {
      const targetPath = path.slice(prefix.length);
      // 确保 upstream 以 / 结尾，targetPath 不以 / 开头
      const normalizedUpstream = upstream.endsWith("/") ? upstream : upstream + "/";
      const normalizedPath = targetPath.startsWith("/") ? targetPath.slice(1) : targetPath;
      return proxyRequest(req, normalizedUpstream, normalizedPath, url.search);
    }
  }

  return jsonResponse({ error: "Not Found", path }, 404);
});

// ==================== 鉴权 ====================

function checkAuth(req: Request): Response | null {
  const password = Deno.env.get("PROXY_PASSWORD");
  if (!password) return null; // 未设置密码，允许访问

  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Basic ")) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": 'Basic realm="proxy"' }
    });
  }

  const expected = "Basic " + btoa(`proxy:${password}`);
  if (auth !== expected) {
    return new Response("Forbidden", { status: 403 });
  }

  return null;
}

// ==================== 通用代理 ====================

async function proxyRequest(
  req: Request,
  upstream: string,
  targetPath: string,
  search: string
): Promise<Response> {
  const targetUrl = upstream + targetPath + search;

  try {
    // 构建请求头
    const headers = filterHeaders(req.headers);
    headers.set("host", new URL(upstream).host);
    // GitHub 要求设置 User-Agent
    headers.set("user-agent", "github-docker-proxy/1.0");

    // 发起请求
    let resp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      redirect: "manual",
    });

    // 处理重定向：重写 Location 头
    if ([301, 302, 307, 308].includes(resp.status)) {
      const location = resp.headers.get("location");
      if (location) {
        const newLocation = rewriteLocation(location);
        const newResp = new Response(null, { status: resp.status });
        newResp.headers.set("location", newLocation);
        copyHeaders(resp.headers, newResp.headers, ["location"]);
        return newResp;
      }
    }

    // 流式转发
    const newResp = new Response(resp.body, { status: resp.status });
    copyHeaders(resp.headers, newResp.headers);

    return newResp;
  } catch (error) {
    console.error("Proxy error:", error);
    return jsonResponse({ 
      error: "Proxy Error", 
      message: error.message,
      target: targetUrl 
    }, 500);
  }
}

// ==================== Docker Registry 代理 ====================

async function handleDockerProxy(
  req: Request,
  path: string,
  search: string
): Promise<Response> {
  const targetUrl = DOCKER_HUB + path + search;

  // 第一次请求
  let resp = await fetch(targetUrl, {
    method: req.method,
    headers: filterHeaders(req.headers),
    redirect: "manual",
  });

  // 处理 401：获取 Docker Hub Token
  if (resp.status === 401) {
    const authHeader = resp.headers.get("www-authenticate");
    if (authHeader) {
      const { realm, service, scope } = parseDockerAuth(authHeader);
      
      // 构建 token 请求 URL
      const tokenUrl = new URL(realm);
      if (service) tokenUrl.searchParams.set("service", service);
      if (scope) tokenUrl.searchParams.set("scope", scope);
      
      // 可选：使用 Docker Hub 账号密码获取更高限额
      const dockerUser = Deno.env.get("DOCKER_HUB_USERNAME");
      const dockerPass = Deno.env.get("DOCKER_HUB_PASSWORD");
      const tokenHeaders: HeadersInit = {};
      if (dockerUser && dockerPass) {
        tokenHeaders["authorization"] = "Basic " + btoa(`${dockerUser}:${dockerPass}`);
      }

      const tokenResp = await fetch(tokenUrl.toString(), { headers: tokenHeaders });
      if (tokenResp.ok) {
        const { token, access_token } = await tokenResp.json();
        const bearer = token || access_token;

        // 带 token 重新请求
        const headers = filterHeaders(req.headers);
        headers.set("authorization", `Bearer ${bearer}`);
        
        resp = await fetch(targetUrl, {
          method: req.method,
          headers,
          redirect: "manual",
        });
      }
    }
  }

  // 处理重定向
  if ([301, 302, 307, 308].includes(resp.status)) {
    const location = resp.headers.get("location");
    if (location) {
      const newLocation = rewriteDockerLocation(location);
      const newResp = new Response(null, { status: resp.status });
      newResp.headers.set("location", newLocation);
      copyHeaders(resp.headers, newResp.headers, ["location"]);
      return newResp;
    }
  }

  // 流式转发
  const newResp = new Response(resp.body, { status: resp.status });
  copyHeaders(resp.headers, newResp.headers);

  return newResp;
}

function parseDockerAuth(header: string): { realm: string; service?: string; scope?: string } {
  // 解析: Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"
  const result: { realm: string; service?: string; scope?: string } = { realm: "" };
  
  const realmMatch = header.match(/realm="([^"]+)"/);
  if (realmMatch) result.realm = realmMatch[1];
  
  const serviceMatch = header.match(/service="([^"]+)"/);
  if (serviceMatch) result.service = serviceMatch[1];
  
  const scopeMatch = header.match(/scope="([^"]+)"/);
  if (scopeMatch) result.scope = scopeMatch[1];
  
  return result;
}

function rewriteDockerLocation(location: string): string {
  // 把 Docker Hub 的重定向改写到代理路径
  try {
    const url = new URL(location);
    
    // registry-1.docker.io → /v2/
    if (url.host === "registry-1.docker.io") {
      return "/v2/" + url.pathname.slice(4) + url.search; // 去掉 /v2/
    }
    
    // auth.docker.io → 保留（客户端会重新请求）
    if (url.host === "auth.docker.io") {
      return "/auth/" + url.pathname + url.search;
    }
    
    // production.cloudflare.docker.com → 直连（CDN，通常可访问）
    return location;
  } catch {
    return location;
  }
}

// ==================== 工具函数 ====================

function filterHeaders(headers: Headers): Headers {
  const filtered = new Headers();
  const skip = new Set([
    "host", "content-length", "transfer-encoding", "connection",
    "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host",
  ]);
  
  headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) {
      filtered.set(key, value);
    }
  });
  
  return filtered;
}

function copyHeaders(from: Headers, to: Headers, skip: string[] = []) {
  const skipSet = new Set([
    "host", "content-length", "transfer-encoding", "connection",
    ...skip.map(s => s.toLowerCase())
  ]);
  
  from.forEach((value, key) => {
    if (!skipSet.has(key.toLowerCase())) {
      to.set(key, value);
    }
  });
}

function rewriteLocation(location: string): string {
  // 把上游重定向改写到代理前缀
  try {
    const url = new URL(location);
    
    for (const [prefix, upstream] of Object.entries(UPSTREAMS)) {
      if (url.origin === upstream) {
        return prefix + url.pathname + url.search;
      }
    }
    
    // GitHub 特殊处理：github.com/xxx/releases/download/... 会重定向到 objects.githubusercontent.com
    if (url.host === "objects.githubusercontent.com") {
      return "/objects/" + url.pathname + url.search;
    }
    
    // GitHub Release 资产重定向到 release-assets.githubusercontent.com
    if (url.host === "release-assets.githubusercontent.com") {
      return "/release-assets/" + url.pathname + url.search;
    }
    
    return location;
  } catch {
    return location;
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// ==================== 首页 HTML ====================

const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="GitHub & Docker 资源加速代理 - 基于 Deno Deploy 的免费边缘网络">
  <title>GitHub & Docker Proxy · 边缘加速</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚀</text></svg>">
  <style>
    :root {
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-tertiary: #21262d;
      --border: #30363d;
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --text-muted: #6e7681;
      --accent: #58a6ff;
      --accent-hover: #79b8ff;
      --accent-green: #3fb950;
      --accent-orange: #d29922;
      --accent-purple: #bc8cff;
      --accent-red: #f85149;
      --gradient-1: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      --gradient-2: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      --gradient-3: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
      --gradient-4: linear-gradient(135deg, #43e97b 0%, #38f9d7 100%);
      --shadow: 0 8px 24px rgba(0,0,0,0.4);
      --shadow-sm: 0 2px 8px rgba(0,0,0,0.3);
      --radius: 12px;
      --radius-sm: 8px;
      --mono: "SF Mono", "Cascadia Code", Consolas, "Liberation Mono", Menlo, monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "Helvetica Neue", Arial, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      min-height: 100vh;
    }

    /* ===== 背景装饰 ===== */
    .bg-decoration {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      z-index: -1;
      overflow: hidden;
      pointer-events: none;
    }
    .bg-decoration::before {
      content: '';
      position: absolute;
      top: -50%; left: -50%;
      width: 200%; height: 200%;
      background: radial-gradient(circle at 20% 80%, rgba(120, 119, 198, 0.1) 0%, transparent 50%),
                  radial-gradient(circle at 80% 20%, rgba(255, 119, 168, 0.08) 0%, transparent 50%),
                  radial-gradient(circle at 40% 40%, rgba(88, 166, 255, 0.05) 0%, transparent 50%);
      animation: bgFloat 20s ease-in-out infinite;
    }
    @keyframes bgFloat {
      0%, 100% { transform: translate(0, 0) rotate(0deg); }
      33% { transform: translate(30px, -30px) rotate(1deg); }
      66% { transform: translate(-20px, 20px) rotate(-1deg); }
    }

    /* ===== 布局 ===== */
    .container {
      max-width: 960px;
      margin: 0 auto;
      padding: 0 24px;
    }

    /* ===== 头部 Hero ===== */
    .hero {
      text-align: center;
      padding: 80px 24px 60px;
      position: relative;
    }
    .hero-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 16px;
      background: rgba(63, 185, 80, 0.1);
      border: 1px solid rgba(63, 185, 80, 0.3);
      border-radius: 20px;
      font-size: 13px;
      color: var(--accent-green);
      margin-bottom: 24px;
    }
    .hero-badge .dot {
      width: 8px; height: 8px;
      background: var(--accent-green);
      border-radius: 50%;
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(0.9); }
    }
    .hero h1 {
      font-size: clamp(32px, 6vw, 52px);
      font-weight: 800;
      letter-spacing: -1px;
      margin-bottom: 16px;
      background: linear-gradient(135deg, #e6edf3 0%, #8b949e 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .hero h1 .highlight {
      background: var(--gradient-1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .hero p {
      font-size: 18px;
      color: var(--text-secondary);
      max-width: 600px;
      margin: 0 auto 32px;
    }
    .hero-stats {
      display: flex;
      justify-content: center;
      gap: 40px;
      margin-top: 40px;
    }
    .stat {
      text-align: center;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--accent);
    }
    .stat-label {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    /* ===== 卡片通用 ===== */
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 32px;
      margin-bottom: 24px;
      transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
    }
    .card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow);
      border-color: rgba(88, 166, 255, 0.3);
    }
    .card-title {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .card-title .icon {
      width: 36px; height: 36px;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    .icon-github { background: rgba(88, 166, 255, 0.15); }
    .icon-docker { background: rgba(67, 233, 123, 0.15); }
    .icon-terminal { background: rgba(188, 140, 255, 0.15); }
    .icon-config { background: rgba(210, 153, 34, 0.15); }

    /* ===== URL 转换器 ===== */
    .converter {
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      padding: 24px;
      margin: 20px 0;
    }
    .converter-input-group {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }
    .converter-input {
      flex: 1;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 14px 18px;
      color: var(--text-primary);
      font-family: var(--mono);
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .converter-input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.15);
    }
    .converter-input::placeholder {
      color: var(--text-muted);
    }
    .converter-select {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 14px 16px;
      color: var(--text-primary);
      font-size: 14px;
      outline: none;
      cursor: pointer;
      min-width: 140px;
    }
    .converter-select:focus {
      border-color: var(--accent);
    }
    .converter-result {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 14px 18px;
      font-family: var(--mono);
      font-size: 14px;
      color: var(--accent-green);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      word-break: break-all;
    }
    .converter-result .url {
      flex: 1;
    }
    .converter-result .url-prefix {
      color: var(--text-muted);
    }
    .converter-result .url-main {
      color: var(--accent-green);
      font-weight: 600;
    }
    .copy-btn {
      background: rgba(88, 166, 255, 0.15);
      border: 1px solid rgba(88, 166, 255, 0.3);
      border-radius: 6px;
      padding: 8px 14px;
      color: var(--accent);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .copy-btn:hover {
      background: rgba(88, 166, 255, 0.25);
      border-color: var(--accent);
    }
    .copy-btn.copied {
      background: rgba(63, 185, 80, 0.15);
      border-color: var(--accent-green);
      color: var(--accent-green);
    }

    /* ===== 端点列表 ===== */
    .endpoints-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 12px;
      margin-top: 16px;
    }
    .endpoint-item {
      background: var(--bg-tertiary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 14px 18px;
      display: flex;
      align-items: center;
      gap: 12px;
      transition: border-color 0.2s, background 0.2s;
    }
    .endpoint-item:hover {
      border-color: rgba(88, 166, 255, 0.4);
      background: rgba(88, 166, 255, 0.05);
    }
    .endpoint-item .prefix {
      font-family: var(--mono);
      font-size: 13px;
      font-weight: 600;
      color: var(--accent);
      background: rgba(88, 166, 255, 0.1);
      padding: 4px 10px;
      border-radius: 6px;
      min-width: 70px;
      text-align: center;
    }
    .endpoint-item .target {
      font-size: 13px;
      color: var(--text-secondary);
    }

    /* ===== 代码块 ===== */
    .code-block {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      margin: 12px 0;
      overflow: hidden;
    }
    .code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: rgba(255,255,255,0.03);
      border-bottom: 1px solid var(--border);
    }
    .code-header .lang {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .code-body {
      padding: 16px;
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.7;
      overflow-x: auto;
      color: var(--text-secondary);
    }
    .code-body .comment { color: var(--text-muted); }
    .code-body .cmd { color: var(--accent); }
    .code-body .string { color: var(--accent-green); }
    .code-body .flag { color: var(--accent-orange); }

    /* ===== 标签页 ===== */
    .tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 20px;
      background: var(--bg-tertiary);
      padding: 4px;
      border-radius: var(--radius-sm);
      width: fit-content;
    }
    .tab {
      padding: 8px 20px;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
      color: var(--text-secondary);
      transition: all 0.2s;
      border: none;
      background: none;
    }
    .tab:hover {
      color: var(--text-primary);
    }
    .tab.active {
      background: rgba(88, 166, 255, 0.15);
      color: var(--accent);
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* ===== 提示框 ===== */
    .alert {
      display: flex;
      gap: 12px;
      padding: 16px 20px;
      border-radius: var(--radius-sm);
      margin: 20px 0;
      font-size: 14px;
      align-items: flex-start;
    }
    .alert-warning {
      background: rgba(210, 153, 34, 0.1);
      border: 1px solid rgba(210, 153, 34, 0.3);
      color: var(--accent-orange);
    }
    .alert-info {
      background: rgba(88, 166, 255, 0.1);
      border: 1px solid rgba(88, 166, 255, 0.3);
      color: var(--accent);
    }
    .alert-icon { font-size: 18px; flex-shrink: 0; }

    /* ===== 页脚 ===== */
    .footer {
      text-align: center;
      padding: 40px 24px;
      color: var(--text-muted);
      font-size: 13px;
      border-top: 1px solid var(--border);
      margin-top: 60px;
    }
    .footer a {
      color: var(--accent);
      text-decoration: none;
    }
    .footer a:hover {
      text-decoration: underline;
    }
    .footer .tech-stack {
      display: flex;
      justify-content: center;
      gap: 16px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .footer .tech-tag {
      padding: 4px 12px;
      background: var(--bg-secondary);
      border-radius: 12px;
      font-size: 12px;
    }

    /* ===== 响应式 ===== */
    @media (max-width: 640px) {
      .hero { padding: 60px 16px 40px; }
      .hero-stats { gap: 24px; }
      .card { padding: 24px; }
      .converter-input-group { flex-direction: column; }
      .endpoints-grid { grid-template-columns: 1fr; }
      .tabs { width: 100%; overflow-x: auto; }
      .tab { padding: 8px 14px; font-size: 13px; white-space: nowrap; }
    }

    /* ===== 滚动条 ===== */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: var(--bg-primary); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
  </style>
</head>
<body>
  <div class="bg-decoration"></div>

  <div class="container">
    <!-- Hero -->
    <section class="hero">
      <div class="hero-badge">
        <span class="dot"></span>
        服务运行中 · Deno Deploy Edge
      </div>
      <h1>
        GitHub & Docker<br>
        <span class="highlight">边缘加速代理</span>
      </h1>
      <p>基于 Deno Deploy 全球边缘网络的免费加速服务<br>为开发者提供极速的 GitHub 资源下载与 Docker 镜像拉取体验</p>
      
      <div class="hero-stats">
        <div class="stat">
          <div class="stat-value">100万+</div>
          <div class="stat-label">日请求配额</div>
        </div>
        <div class="stat">
          <div class="stat-value">10+</div>
          <div class="stat-label">支持的上游服务</div>
        </div>
        <div class="stat">
          <div class="stat-value">∞</div>
          <div class="stat-label">文件大小限制</div>
        </div>
      </div>
    </section>

    <!-- URL 转换器 -->
    <div class="card">
      <div class="card-title">
        <div class="icon icon-terminal">🔗</div>
        快速生成代理链接
      </div>
      
      <div class="converter">
        <div class="converter-input-group">
          <input 
            type="text" 
            class="converter-input" 
            id="urlInput" 
            placeholder="粘贴 GitHub 或 Docker 原始链接..."
            oninput="convertUrl()"
          >
          <select class="converter-select" id="urlType" onchange="convertUrl()">
            <option value="auto">自动识别</option>
            <option value="github">GitHub</option>
            <option value="release">Release 下载</option>
            <option value="raw">Raw 文件</option>
            <option value="clone">git clone</option>
            <option value="docker">Docker 镜像</option>
          </select>
        </div>
        <div class="converter-result" id="converterResult" style="display:none;">
          <div class="url" id="convertedUrl"></div>
          <button class="copy-btn" onclick="copyResult()">
            <span id="copyIcon">📋</span>
            <span id="copyText">复制</span>
          </button>
        </div>
      </div>
    </div>

    <!-- GitHub 加速 -->
    <div class="card">
      <div class="card-title">
        <div class="icon icon-github">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" style="color: var(--accent);">
            <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"></path>
          </svg>
        </div>
        GitHub 加速
      </div>

      <div class="tabs">
        <button class="tab active" onclick="switchTab(this, 'release')">📦 Release 下载</button>
        <button class="tab" onclick="switchTab(this, 'clone')">🔄 git clone</button>
        <button class="tab" onclick="switchTab(this, 'raw')">📄 Raw 文件</button>
        <button class="tab" onclick="switchTab(this, 'archive')">🗜️ 源码归档</button>
      </div>

      <div class="tab-content active" id="tab-release">
        <div class="code-block">
          <div class="code-header">
            <span class="lang">Shell</span>
            <button class="copy-btn" onclick="copyCode(this)">📋 复制</button>
          </div>
          <div class="code-body"><span class="comment"># 原始链接</span>
<span class="cmd">curl</span> -L -o app.tar.gz <span class="string">https://github.com/owner/repo/releases/download/v1.0/app.tar.gz</span>

<span class="comment"># 加速链接</span>
<span class="cmd">curl</span> -L -o app.tar.gz <span class="string" id="release-url">https://<span id="domain-release"></span>/gh/owner/repo/releases/download/v1.0/app.tar.gz</span></div>
        </div>
      </div>

      <div class="tab-content" id="tab-clone">
        <div class="code-block">
          <div class="code-header">
            <span class="lang">Shell</span>
            <button class="copy-btn" onclick="copyCode(this)">📋 复制</button>
          </div>
          <div class="code-body"><span class="comment"># 原始命令</span>
<span class="cmd">git</span> clone https://github.com/owner/repo.git

<span class="comment"># 加速命令</span>
<span class="cmd">git</span> clone <span class="string" id="clone-url">https://<span id="domain-clone"></span>/gh/owner/repo.git</span></div>
        </div>
      </div>

      <div class="tab-content" id="tab-raw">
        <div class="code-block">
          <div class="code-header">
            <span class="lang">Shell</span>
            <button class="copy-btn" onclick="copyCode(this)">📋 复制</button>
          </div>
          <div class="code-body"><span class="comment"># 原始链接</span>
<span class="cmd">curl</span> <span class="string">https://raw.githubusercontent.com/owner/repo/main/README.md</span>

<span class="comment"># 加速链接</span>
<span class="cmd">curl</span> <span class="string" id="raw-url">https://<span id="domain-raw"></span>/ghraw/owner/repo/main/README.md</span></div>
        </div>
      </div>

      <div class="tab-content" id="tab-archive">
        <div class="code-block">
          <div class="code-header">
            <span class="lang">Shell</span>
            <button class="copy-btn" onclick="copyCode(this)">📋 复制</button>
          </div>
          <div class="code-body"><span class="comment"># 下载分支归档 (zip)</span>
<span class="cmd">curl</span> -L -o repo.zip <span class="string" id="archive-url">https://<span id="domain-archive"></span>/gh/owner/repo/archive/refs/heads/main.zip</span>

<span class="comment"># 下载分支归档 (tar.gz)</span>
<span class="cmd">curl</span> -L -o repo.tar.gz <span class="string">https://<span id="domain-archive2"></span>/gh/owner/repo/archive/refs/heads/main.tar.gz</span></div>
        </div>
      </div>

      <h4 style="margin-top: 24px; margin-bottom: 12px; color: var(--text-secondary); font-size: 14px;">📋 支持的端点</h4>
      <div class="endpoints-grid">
        <div class="endpoint-item">
          <span class="prefix">/gh/</span>
          <span class="target">github.com 全站代理</span>
        </div>
        <div class="endpoint-item">
          <span class="prefix">/ghraw/</span>
          <span class="target">raw.githubusercontent.com</span>
        </div>
        <div class="endpoint-item">
          <span class="prefix">/codeload/</span>
          <span class="target">codeload.github.com</span>
        </div>
        <div class="endpoint-item">
          <span class="prefix">/objects/</span>
          <span class="target">objects.githubusercontent.com</span>
        </div>
        <div class="endpoint-item">
          <span class="prefix">/release-assets/</span>
          <span class="target">release-assets.githubusercontent.com</span>
        </div>
        <div class="endpoint-item">
          <span class="prefix">/api.github.com/</span>
          <span class="target">api.github.com API 代理</span>
        </div>
      </div>
    </div>

    <!-- Docker 加速 -->
    <div class="card">
      <div class="card-title">
        <div class="icon icon-docker">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="color: var(--accent-green);">
            <path d="M13.98 10.08l-.01.01c-.02.01-.05.03-.08.04-.06.02-.12.03-.18.03-.09 0-.17-.02-.25-.06-.05-.03-.09-.07-.13-.12-.02-.03-.04-.06-.06-.1-.02-.04-.04-.08-.05-.12h.02c.01-.01.02-.02.03-.03.02-.02.04-.04.06-.06.02-.02.03-.04.04-.06.01-.02.02-.04.03-.06l.01-.02c.02-.04.04-.08.06-.12.02-.04.03-.08.04-.12.01-.04.02-.08.02-.12v-.02c0-.04-.01-.08-.02-.12-.01-.04-.02-.08-.04-.12-.02-.04-.04-.08-.06-.12-.02-.04-.04-.08-.07-.12l-.01-.02c-.01-.02-.02-.04-.03-.06-.01-.02-.02-.04-.04-.06-.02-.02-.04-.04-.06-.06-.01-.01-.02-.02-.03-.03h-.02c-.01-.04-.03-.08-.05-.12-.02-.04-.04-.07-.06-.1-.04-.05-.08-.09-.13-.12-.08-.04-.16-.06-.25-.06-.06 0-.12.01-.18.03-.03.01-.06.03-.08.04l-.01.01c-.02.02-.05.05-.07.08-.02.03-.04.06-.06.09-.02.03-.03.06-.04.1-.01.03-.02.07-.02.1v.02c0 .04.01.08.02.12.01.04.02.08.04.12.02.04.04.08.06.12l.01.02c.01.02.02.04.03.06.01.02.02.04.04.06.02.02.04.04.06.06.01.01.02.02.03.03m-1.48-.62c-.09 0-.17.02-.25.06-.05.03-.09.07-.13.12-.02.03-.04.06-.06.1-.02.04-.04.08-.05.12h.02c.01.01.02.02.03.03.02.02.04.04.06.06.02.02.03.04.04.06.01.02.02.04.03.06l.01.02c.02.04.04.08.06.12.02.04.03.08.04.12.01.04.02.08.02.12v.02c0 .04-.01.08-.02.12-.01.04-.02.08-.04.12-.02.04-.04.08-.06.12-.02.04-.04.08-.07.12l-.01.02c-.01.02-.02.04-.03.06-.01.02-.02.04-.04.06-.02.02-.04.04-.06.06-.01.01-.02.02-.03.03h-.02c-.01.04-.03.08-.05.12-.02.04-.04.07-.06.1-.04.05-.08.09-.13.12-.08.04-.16.06-.25.06-.06 0-.12-.01-.18-.03-.03-.01-.06-.03-.08-.04l-.01-.01c-.02-.02-.05-.05-.07-.08-.02-.03-.04-.06-.06-.09-.02-.03-.03-.06-.04-.1-.01-.03-.02-.07-.02-.1v-.02c0-.04.01-.08.02-.12.01-.04.02-.08.04-.12.02-.04.04-.08.06-.12l.01-.02c.01-.02.02-.04.03-.06.01-.02.02-.04.04-.06.02-.02.04-.04.06-.06.01-.01.02-.02.03-.03m-1.48-.62c-.09 0-.17.02-.25.06-.05.03-.09.07-.13.12-.02.03-.04.06-.06.1-.02.04-.04.08-.05.12h.02c.01.01.02.02.03.03.02.02.04.04.06.06.02.02.03.04.04.06.01.02.02.04.03.06l.01.02c.02.04.04.08.06.12.02.04.03.08.04.12.01.04.02.08.02.12v.02c0 .04-.01.08-.02.12-.01.04-.02.08-.04.12-.02.04-.04.08-.06.12-.02.04-.04.08-.07.12l-.01.02c-.01.02-.02.04-.03.06-.01.02-.02.04-.04.06-.02.02-.04.04-.06.06-.01.01-.02.02-.03.03h-.02c-.01.04-.03.08-.05.12-.02.04-.04.07-.06.1-.04.05-.08.09-.13.12-.08.04-.16.06-.25.06-.06 0-.12-.01-.18-.03-.03-.01-.06-.03-.08-.04l-.01-.01c-.02-.02-.05-.05-.07-.08-.02-.03-.04-.06-.06-.09-.02-.03-.03-.06-.04-.1-.01-.03-.02-.07-.02-.1v-.02c0-.04.01-.08.02-.12.01-.04.02-.08.04-.12.02-.04.04-.08.06-.12l.01-.02c.01-.02.02-.04.03-.06.01-.02.02-.04.04-.06.02-.02.04-.04.06-.06.01-.01.02-.02.03-.03m-1.48-.62c-.09 0-.17.02-.25.06-.05.03-.09.07-.13.12-.02.03-.04.06-.06.1-.02.04-.04.08-.05.12h.02c.01.01.02.02.03.03.02.02.04.04.06.06.02.02.03.04.04.06.01.02.02.04.03.06l.01.02c.02.04.04.08.06.12.02.04.03.08.04.12.01.04.02.08.02.12v.02c0 .04-.01.08-.02.12-.01.04-.02.08-.04.12-.02.04-.04.08-.06.12-.02.04-.04.08-.07.12l-.01.02c-.01.02-.02.04-.03.06-.01.02-.02.04-.04.06-.02.02-.04.04-.06.06-.01.01-.02.02-.03.03h-.02c-.01.04-.03.08-.05.12-.02.04-.04.07-.06.1-.04.05-.08.09-.13.12-.08.04-.16.06-.25.06-.06 0-.12-.01-.18-.03-.03-.01-.06-.03-.08-.04l-.01-.01c-.02-.02-.05-.05-.07-.08-.02-.03-.04-.06-.06-.09-.02-.03-.03-.06-.04-.1-.01-.03-.02-.07-.02-.1v-.02c0-.04.01-.08.02-.12.01-.04.02-.08.04-.12.02-.04.04-.08.06-.12l.01-.02c.01-.02.02-.04.03-.06.01-.02.02-.04.04-.06.02-.02.04-.04.06-.06.01-.01.02-.02.03-.03m5.92-3.02c-.09 0-.17.02-.25.06-.05.03-.09.07-.13.12-.02.03-.04.06-.06.1-.02.04-.04.08-.05.12h.02c.01.01.02.02.03.03.02.02.04.04.06.06.02.02.03.04.04.06.01.02.02.04.03.06l.01.02c.02.04.04.08.06.12.02.04.03.08.04.12.01.04.02.08.02.12v.02c0 .04-.01.08-.02.12-.01.04-.02.08-.04.12-.02.04-.04.08-.06.12-.02.04-.04.08-.07.12l-.01.02c-.01.02-.02.04-.03.06-.01.02-.02.04-.04.06-.02.02-.04.04-.06.06-.01.01-.02.02-.03.03h-.02c-.01.04-.03.08-.05.12-.02.04-.04.07-.06.1-.04.05-.08.09-.13.12-.08.04-.16.06-.25.06-.06 0-.12-.01-.18-.03-.03-.01-.06-.03-.08-.04l-.01-.01c-.02-.02-.05-.05-.07-.08-.02-.03-.04-.06-.06-.09-.02-.03-.03-.06-.04-.1-.01-.03-.02-.07-.02-.1v-.02c0-.04.01-.08.02-.12.01-.04.02-.08.04-.12.02-.04.04-.08.06-.12l.01-.02c.01-.02.02-.04.03-.06.01-.02.02-.04.04-.06.02-.02.04-.04.06-.06.01-.01.02-.02.03-.03m-1.48-.62c-.09 0-.17.02-.25.06-.05.03-.09.07-.13.12-.02.03-.04.06-.06.1-.02.04-.04.08-.05.12h.02c.01.01.02.02.03.03.02.02.04.04.06.06.02.02.03.04.04.06.01.02.02.04.03.06l.01.02c.02.04.04.08.06.12.02.04.03.08.04.12.01.04.02.08.02.12v.02c0 .04-.01.08-.02.12-.01.04-.02.08-.04.12-.02.04-.04.08-.06.12-.02.04-.04.08-.07.12l-.01.02c-.01.02-.02.04-.03.06-.01.02-.02.04-.04.06-.02.02-.04.04-.06.06-.01.01-.02.02-.03.03h-.02c-.01.04-.03.08-.05.12-.02.04-.04.07-.06.1-.04.05-.08.09-.13.12-.08.04-.16.06-.25.06-.06 0-.12-.01-.18-.03-.03-.01-.06-.03-.08-.04l-.01-.01c-.02-.02-.05-.05-.07-.08-.02-.03-.04-.06-.06-.09-.02-.03-.03-.06-.04-.1-.01-.03-.02-.07-.02-.1v-.02c0-.04.01-.08.02-.12.01-.04.02-.08.04-.12.02-.04.04-.08.06-.12l.01-.02c.01-.02.02-.04.03-.06.01-.02.02-.04.04-.06.02-.02.04-.04.06-.06.01-.01.02-.02.03-.03m-1.48-.62c-.09 0-.17.02-.25.06-.05.03-.09.07-.13.12-.02.03-.04.06-.06.1-.02.04-.04.08-.05.12h.02c.01.01.02.02.03.03.02.02.04.04.06.06.02.02.03.04.04.06.01.02.02.04.03.06l.01.02c.02.04.04.08.06.12.02.04.03.08.04.12.01.04.02.08.02.12v.02c0 .04-.01.08-.02.12-.01.04-.02.08-.04.12-.02.04-.04.08-.06.12-.02.04-.04.08-.07.12l-.01.02c-.01.02-.02.04-.03.06-.01.02-.02.04-.04.06-.02.02-.04.04-.06.06-.01.01-.02.02-.03.03h-.02c-.01.04-.03.08-.05.12-.02.04-.04.07-.06.1-.04.05-.08.09-.13.12-.08.04-.16.06-.25.06-.06 0-.12-.01-.18-.03-.03-.01-.06-.03-.08-.04l-.01-.01c-.02-.02-.05-.05-.07-.08-.02-.03-.04-.06-.06-.09-.02-.03-.03-.06-.04-.1-.01-.03-.02-.07-.02-.1v-.02c0-.04.01-.08.02-.12.01-.04.02-.08.04-.12.02-.04.04-.08.06-.12l.01-.02c.01-.02.02-.04.03-.06.01-.02.02-.04.04-.06.02-.02.04-.04.06-.06.01-.01.02-.02.03-.03m-1.48-.62c-.09 0-.17.02-.25.06-.05.03-.09.07-.13.12-.02.03-.04.06-.06.1-.02.04-.04.08-.05.12h.02c.01.01.02.02.03.03.02.02.04.04.06.06.02.02.03.04.04.06.01.02.02.04.03.06l.01.02c.02.04.04.08.06.12.02.04.03.08.04.12.01.04.02.08.02.12v.02c0 .04-.01.08-.02.12-.01.04-.02.08-.04.12-.02.04-.04.08-.06.12-.02.04-.04.08-.07.12l-.01.02c-.01.02-.02.04-.03.06-.01.02-.02.04-.04.06-.02.02-.04.04-.06.06-.01.01-.02.02-.03.03h-.02c-.01.04-.03.08-.05.12-.02.04-.04.07-.06.1-.04.05-.08.09-.13.12-.08.04-.16.06-.25.06-.06 0-.12-.01-.18-.03-.03-.01-.06-.03-.08-.04l-.01-.01c-.02-.02-.05-.05-.07-.08-.02-.03-.04-.06-.06-.09-.02-.03-.03-.06-.04-.1-.01-.03-.02-.07-.02-.1v-.02c0-.04.01-.08.02-.12.01-.04.02-.08.04-.12.02-.04.04-.08.06-.12l.01-.02c.01-.02.02-.04.03-.06.01-.02.02-.04.04-.06.02-.02.04-.04.06-.06.01-.01.02-.02.03-.03"/>
          </svg>
        </div>
        Docker 镜像加速
      </div>

      <div class="alert alert-info">
        <span class="alert-icon">💡</span>
        <span>配置 Docker 镜像加速器后，拉取 Docker Hub、GHCR、GCR、Quay 等镜像将自动通过代理加速。</span>
      </div>

      <div class="code-block">
        <div class="code-header">
          <span class="lang">JSON · /etc/docker/daemon.json</span>
          <button class="copy-btn" onclick="copyCode(this)">📋 复制</button>
        </div>
        <div class="code-body">{
  <span class="string">"registry-mirrors"</span>: [<span class="string" id="docker-config">"https://"</span>]
}</div>
      </div>

      <div class="code-block">
        <div class="code-header">
          <span class="lang">Shell</span>
          <button class="copy-btn" onclick="copyCode(this)">📋 复制</button>
        </div>
        <div class="code-body"><span class="comment"># 重启 Docker 服务</span>
<span class="cmd">sudo</span> systemctl daemon-reload
<span class="cmd">sudo</span> systemctl restart docker

<span class="comment"># 或者直接拉取镜像（无需配置）</span>
<span class="cmd">docker</span> pull <span class="string" id="docker-pull">https://</span>/library/nginx:latest</div>
      </div>

      <h4 style="margin-top: 24px; margin-bottom: 12px; color: var(--text-secondary); font-size: 14px;">📋 支持的 Registry</h4>
      <div class="endpoints-grid">
        <div class="endpoint-item">
          <span class="prefix">/v2/</span>
          <span class="target">Docker Hub (registry-1.docker.io)</span>
        </div>
        <div class="endpoint-item">
          <span class="prefix">/ghcr/</span>
          <span class="target">GitHub Container Registry</span>
        </div>
        <div class="endpoint-item">
          <span class="prefix">/gcr/</span>
          <span class="target">Google Container Registry</span>
        </div>
        <div class="endpoint-item">
          <span class="prefix">/k8s/</span>
          <span class="target">Kubernetes Registry</span>
        </div>
        <div class="endpoint-item">
          <span class="prefix">/quay/</span>
          <span class="target">Red Hat Quay</span>
        </div>
      </div>
    </div>

    <!-- 高级用法 -->
    <div class="card">
      <div class="card-title">
        <div class="icon icon-config">⚙️</div>
        高级配置
      </div>

      <div class="alert alert-warning">
        <span class="alert-icon">⚠️</span>
        <span><strong>鉴权保护</strong>：如需防止滥用，可在 Deno Deploy Dashboard 中设置 <code style="font-family: var(--mono); background: rgba(0,0,0,0.2); padding: 2px 8px; border-radius: 4px;">PROXY_PASSWORD</code> 环境变量启用 Basic Auth。</span>
      </div>

      <div class="code-block">
        <div class="code-header">
          <span class="lang">Shell · 带鉴权的请求</span>
          <button class="copy-btn" onclick="copyCode(this)">📋 复制</button>
        </div>
        <div class="code-body"><span class="comment"># 设置环境变量</span>
<span class="cmd">export</span> PROXY_PASSWORD=<span class="string">"your-secret-password"</span>

<span class="comment"># 使用 curl 时添加认证头</span>
<span class="cmd">curl</span> -u proxy:<span class="string">$PROXY_PASSWORD</span> -L <span class="string" id="auth-url">https://</span>/gh/owner/repo/releases/download/v1.0/app.tar.gz</div>
      </div>

      <div class="code-block">
        <div class="code-header">
          <span class="lang">Shell · Docker 客户端认证</span>
          <button class="copy-btn" onclick="copyCode(this)">📋 复制</button>
        </div>
        <div class="code-body"><span class="comment"># 登录到代理 registry</span>
<span class="cmd">docker</span> login <span class="string" id="docker-login">https://</span> -u proxy -p <span class="string">$PROXY_PASSWORD</span></div>
      </div>
    </div>

    <!-- 限制说明 -->
    <div class="card">
      <div class="card-title">
        <div class="icon icon-terminal">📊</div>
        服务限制与配额
      </div>
      
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin-top: 8px;">
        <div style="background: var(--bg-tertiary); padding: 20px; border-radius: var(--radius-sm); text-align: center;">
          <div style="font-size: 32px; margin-bottom: 8px;">🚀</div>
          <div style="font-size: 20px; font-weight: 700; color: var(--accent);">100万/天</div>
          <div style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">请求配额</div>
        </div>
        <div style="background: var(--bg-tertiary); padding: 20px; border-radius: var(--radius-sm); text-align: center;">
          <div style="font-size: 32px; margin-bottom: 8px;">📦</div>
          <div style="font-size: 20px; font-weight: 700; color: var(--accent-green);">无限制</div>
          <div style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">文件大小</div>
        </div>
        <div style="background: var(--bg-tertiary); padding: 20px; border-radius: var(--radius-sm); text-align: center;">
          <div style="font-size: 32px; margin-bottom: 8px;">⚡</div>
          <div style="font-size: 20px; font-weight: 700; color: var(--accent-purple);">128MB</div>
          <div style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">内存限制</div>
        </div>
        <div style="background: var(--bg-tertiary); padding: 20px; border-radius: var(--radius-sm); text-align: center;">
          <div style="font-size: 32px; margin-bottom: 8px;">🌐</div>
          <div style="font-size: 20px; font-weight: 700; color: var(--accent-orange);">全球边缘</div>
          <div style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">Deno Deploy CDN</div>
        </div>
      </div>

      <div style="margin-top: 20px; font-size: 14px; color: var(--text-secondary); line-height: 2;">
        <strong style="color: var(--text-primary);">✅ 支持的功能</strong><br>
        · GitHub Release / Archive / Raw 文件下载加速<br>
        · git clone 智能 HTTP 协议代理<br>
        · Docker Hub / GHCR / GCR / Quay 镜像拉取<br>
        · 大文件流式传输（GB 级文件无压力）<br>
        · 自动处理 Docker Registry Token 认证<br><br>
        
        <strong style="color: var(--text-primary);">❌ 不支持的功能</strong><br>
        · WebSocket 长连接<br>
        · HTTP/2 Server Push<br>
        · 大文件上传（>100MB 请求体限制）<br>
        · git push（受请求体大小限制）
      </div>
    </div>
  </div>

  <footer class="footer">
    <p>基于 <a href="https://deno.com/deploy" target="_blank">Deno Deploy</a> 构建 · 开源项目</p>
    <div class="tech-stack">
      <span class="tech-tag">Deno</span>
      <span class="tech-tag">TypeScript</span>
      <span class="tech-tag">Edge Network</span>
      <span class="tech-tag">Serverless</span>
    </div>
  </footer>

  <script>
    const HOST = window.location.host;
    const PROTOCOL = window.location.protocol;
    const BASE = PROTOCOL + '//' + HOST;
    
    // 自动填充所有域名字段
    document.querySelectorAll('[id^="domain-"]').forEach(el => {
      el.textContent = HOST;
    });
    document.getElementById('docker-config').textContent = '"' + BASE + '"';
    document.getElementById('docker-pull').textContent = BASE;
    document.getElementById('docker-login').textContent = BASE;
    document.getElementById('auth-url').textContent = BASE;
    document.getElementById('release-url').textContent = BASE + '/gh/owner/repo/releases/download/v1.0/app.tar.gz';
    document.getElementById('clone-url').textContent = BASE + '/gh/owner/repo.git';
    document.getElementById('raw-url').textContent = BASE + '/ghraw/owner/repo/main/README.md';
    document.getElementById('archive-url').textContent = BASE + '/gh/owner/repo/archive/refs/heads/main.zip';
    
    const archive2 = document.getElementById('domain-archive2');
    if (archive2) archive2.textContent = HOST;

    // 标签页切换
    function switchTab(btn, tabId) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + tabId).classList.add('active');
    }

    // URL 转换器
    function convertUrl() {
      const input = document.getElementById('urlInput').value.trim();
      const type = document.getElementById('urlType').value;
      const resultDiv = document.getElementById('converterResult');
      const urlDiv = document.getElementById('convertedUrl');
      
      if (!input) {
        resultDiv.style.display = 'none';
        return;
      }

      let converted = '';
      let path = '';

      try {
        const url = new URL(input.startsWith('http') ? input : 'https://' + input);
        path = url.pathname;
        const host = url.hostname;

        if (type === 'github' || type === 'auto') {
          if (host === 'github.com') {
            if (path.includes('/releases/download/')) {
              converted = BASE + '/gh' + path;
            } else if (path.includes('/archive/')) {
              converted = BASE + '/gh' + path;
            } else if (path.endsWith('.git') || !path.includes('.')) {
              converted = BASE + '/gh' + path;
            }
          }
        }

        if (type === 'release' || (type === 'auto' && !converted)) {
          if (host === 'github.com' && path.includes('/releases/download/')) {
            converted = BASE + '/gh' + path;
          }
        }

        if (type === 'raw' || (type === 'auto' && !converted)) {
          if (host === 'raw.githubusercontent.com') {
            converted = BASE + '/ghraw' + path;
          }
        }

        if (type === 'clone' || (type === 'auto' && !converted)) {
          if (host === 'github.com') {
            converted = BASE + '/gh' + path;
          }
        }

        if (type === 'docker' || (type === 'auto' && !converted)) {
          // Docker 镜像格式: owner/image:tag
          if (!input.startsWith('http')) {
            converted = BASE + '/' + input;
          } else if (host === 'docker.io' || host === 'registry-1.docker.io') {
            converted = BASE + path;
          } else if (host === 'ghcr.io') {
            converted = BASE + '/ghcr' + path;
          } else if (host === 'gcr.io') {
            converted = BASE + '/gcr' + path;
          } else if (host === 'quay.io') {
            converted = BASE + '/quay' + path;
          }
        }

        if (!converted) {
          converted = '❌ 无法识别该链接格式';
          urlDiv.innerHTML = '<span style="color: var(--accent-red);">' + converted + '</span>';
        } else {
          urlDiv.innerHTML = '<span class="url-prefix">' + BASE + '</span><span class="url-main">' + converted.substring(BASE.length) + '</span>';
        }

        resultDiv.style.display = 'flex';
      } catch (e) {
        // Docker 镜像名格式
        if (type === 'docker' || type === 'auto') {
          if (/^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[a-zA-Z0-9_][a-zA-Z0-9._-]*)?$/.test(input)) {
            converted = BASE + '/' + input;
            urlDiv.innerHTML = '<span class="url-prefix">' + BASE + '</span><span class="url-main">/' + input + '</span>';
            resultDiv.style.display = 'flex';
            return;
          }
        }
        urlDiv.innerHTML = '<span style="color: var(--accent-red);">❌ 无效的 URL 格式</span>';
        resultDiv.style.display = 'flex';
      }
    }

    // 复制功能
    let lastCopiedBtn = null;
    function copyResult() {
      const urlDiv = document.getElementById('convertedUrl');
      const text = urlDiv.textContent;
      copyText(text, this.event.target.closest('.copy-btn'));
    }

    function copyCode(btn) {
      const codeBody = btn.closest('.code-block').querySelector('.code-body');
      const text = codeBody.textContent;
      copyText(text, btn);
    }

    function copyText(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        if (lastCopiedBtn) {
          lastCopiedBtn.classList.remove('copied');
          lastCopiedBtn.querySelector('span:last-child').textContent = '复制';
        }
        btn.classList.add('copied');
        const icon = btn.querySelector('span:first-child');
        const label = btn.querySelector('span:last-child');
        if (icon) icon.textContent = '✅';
        if (label) label.textContent = '已复制';
        lastCopiedBtn = btn;

        setTimeout(() => {
          btn.classList.remove('copied');
          if (icon) icon.textContent = '📋';
          if (label) label.textContent = '复制';
          lastCopiedBtn = null;
        }, 2000);
      });
    }
  </script>
</body>
</html>`;

// ==================== 诊断端点 ====================

async function diagnosticEndpoint(): Promise<Response> {
  const results: Record<string, any> = {
    timestamp: Date.now(),
    tests: {}
  };

  // 测试 1: 基本 fetch 到 example.com
  try {
    const resp = await fetch("https://example.com", { method: "HEAD" });
    results.tests.example_com = { success: true, status: resp.status };
  } catch (error) {
    results.tests.example_com = { success: false, error: error.message };
  }

  // 测试 2: GitHub API
  try {
    const resp = await fetch("https://api.github.com/repos/octocat/Hello-World", {
      headers: { "User-Agent": "github-docker-proxy/1.0" }
    });
    results.tests.github_api = { 
      success: resp.ok, 
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries())
    };
  } catch (error) {
    results.tests.github_api = { success: false, error: error.message };
  }

  // 测试 3: GitHub 主页
  try {
    const resp = await fetch("https://github.com/octocat/Hello-World", {
      method: "HEAD",
      redirect: "manual"
    });
    results.tests.github_com = { success: true, status: resp.status };
  } catch (error) {
    results.tests.github_com = { success: false, error: error.message };
  }

  return jsonResponse(results);
}

// ==================== 启动信息 ====================

console.log(`🚀 GitHub & Docker Proxy`);
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
