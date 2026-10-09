// GitHub & Docker Registry Proxy on Deno Deploy
// 免费额度：100万请求/天，128MB内存，无CPU时间限制

// 使用 Deno.serve() (Deno Deploy 标准方式)
// 不再需要导入 std/http/server.ts

// ==================== 配置区 ====================
// 设置访问密码（可选），环境变量 PROXY_PASSWORD
// 设置后所有请求需要 Basic Auth: proxy:<password>

const UPSTREAMS: Record<string, string> = {
  // GitHub 相关
  "/gh/": "https://github.com",
  "/ghraw/": "https://raw.githubusercontent.com",
  "/codeload/": "https://codeload.github.com",
  "/objects/": "https://objects.githubusercontent.com",
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

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // 健康检查
  if (path === "/health") {
    return jsonResponse({ status: "ok", timestamp: Date.now() });
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
      return proxyRequest(req, upstream, targetPath, url.search);
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
  <title>GitHub & Docker Proxy</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: #f5f5f5; }
    .container { background: white; border-radius: 8px; padding: 40px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    h1 { color: #333; border-bottom: 2px solid #0066cc; padding-bottom: 10px; }
    h2 { color: #555; margin-top: 30px; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-family: "Consolas", "Monaco", monospace; color: #c7254e; }
    pre { background: #2d2d2d; color: #f8f8f2; padding: 15px; border-radius: 5px; overflow-x: auto; }
    pre code { background: none; color: inherit; }
    .endpoint { background: #e3f2fd; padding: 10px; border-radius: 5px; margin: 10px 0; }
    .note { background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 GitHub & Docker Proxy</h1>
    <p>基于 Deno Deploy 的免费边缘代理，加速 GitHub 和 Docker 资源访问。</p>
    
    <h2>📦 支持的资源</h2>
    
    <div class="endpoint">
      <strong>GitHub 加速</strong><br>
      <code>/gh/owner/repo/releases/download/...</code> → github.com<br>
      <code>/ghraw/owner/repo/branch/file</code> → raw.githubusercontent.com<br>
      <code>/codeload/owner/repo/...</code> → codeload.github.com<br>
      <code>/objects/...</code> → objects.githubusercontent.com
    </div>
    
    <div class="endpoint">
      <strong>Docker 镜像加速</strong><br>
      <code>/v2/</code> → registry-1.docker.io (Docker Hub)<br>
      <code>/ghcr/</code> → ghcr.io (GitHub Container Registry)<br>
      <code>/gcr/</code> → gcr.io (Google Container Registry)<br>
      <code>/k8s/</code> → registry.k8s.io (Kubernetes)<br>
      <code>/quay/</code> → quay.io (Red Hat Quay)
    </div>
    
    <h2>🔧 使用示例</h2>
    
    <h3>GitHub Release 下载</h3>
    <pre><code># 原始: https://github.com/owner/repo/releases/download/v1.0/app.tar.gz
# 代理: https://your-app.deno.dev/gh/owner/repo/releases/download/v1.0/app.tar.gz

curl -L -o app.tar.gz https://your-app.deno.dev/gh/owner/repo/releases/download/v1.0/app.tar.gz</code></pre>
    
    <h3>git clone 加速</h3>
    <pre><code># 原始: git clone https://github.com/owner/repo.git
# 代理: git clone https://your-app.deno.dev/gh/owner/repo.git

git clone https://your-app.deno.dev/gh/owner/repo.git</code></pre>
    
    <h3>Docker Pull 加速</h3>
    <pre><code># 配置 Docker daemon (/etc/docker/daemon.json)
{
  "registry-mirrors": ["https://your-app.deno.dev"]
}

# 或者直接指定镜像
docker pull your-app.deno.dev/library/nginx:latest
docker pull your-app.deno.dev/ghcr.io/owner/image:tag</code></pre>
    
    <div class="note">
      <strong>⚠️ 注意：</strong>如果设置了 PROXY_PASSWORD 环境变量，所有请求需要 Basic Auth。
    </div>
    
    <h2>📊 限制</h2>
    <ul>
      <li>免费额度：100万请求/天（Deno Deploy）</li>
      <li>内存：128MB/请求</li>
      <li>大文件：支持流式传输，无大小限制</li>
      <li>不支持：WebSocket、长连接</li>
    </ul>
    
    <hr>
    <p style="text-align: center; color: #999; font-size: 14px;">
      Powered by <a href="https://deno.com/deploy">Deno Deploy</a>
    </p>
  </div>
</body>
</html>`;
