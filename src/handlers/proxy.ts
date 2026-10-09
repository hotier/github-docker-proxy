// 代理请求处理器

import { jsonResponse, filterHeaders, copyHeaders } from "../utils/helpers.ts";

export async function proxyRequest(
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

export async function handleDockerProxy(
  req: Request,
  path: string,
  search: string,
  dockerHub: string,
  dockerAuth: string
): Promise<Response> {
  const targetUrl = dockerHub + path + search;

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

function rewriteLocation(location: string): string {
  // 把上游重定向改写到代理前缀
  try {
    const url = new URL(location);
    
    const UPSTREAMS: Record<string, string> = {
      "/gh/": "https://github.com",
      "/ghraw/": "https://raw.githubusercontent.com",
      "/codeload/": "https://codeload.github.com",
      "/objects/": "https://objects.githubusercontent.com",
      "/release-assets/": "https://release-assets.githubusercontent.com",
      "/api.github.com/": "https://api.github.com",
      "/avatars/": "https://avatars.githubusercontent.com",
      "/ghcr/": "https://ghcr.io",
      "/gcr/": "https://gcr.io",
      "/k8s/": "https://registry.k8s.io",
      "/quay/": "https://quay.io",
      "/docker.io/": "https://registry-1.docker.io",
    };
    
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
