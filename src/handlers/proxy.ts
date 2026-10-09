// 增强的代理请求处理器（参考 hunshcn/gh-proxy）

import { CONFIG, isWhitelisted, isBlacklisted, shouldUseJsDelivr, convertToJsDelivr } from "../config.ts";
import { jsonResponse, filterHeaders, copyHeaders } from "../utils/helpers.ts";

// Hop-by-hop 头列表（参考 RFC 2616）
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
];

// 剥离请求中的 hop-by-hop 头
function stripRequestHeaders(headers: Headers): Headers {
  const filtered = new Headers();
  headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      filtered.set(key, value);
    }
  });
  // 设置 User-Agent（GitHub API 要求）
  filtered.set("user-agent", "github-docker-proxy/1.0");
  return filtered;
}

// 从路径中提取仓库信息
function extractRepo(path: string): string | null {
  const match = path.match(/([^\/]+)\/([^\/]+)/);
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return null;
}

// 主代理函数
export async function proxyRequest(
  req: Request,
  upstream: string,
  targetPath: string,
  search: string
): Promise<Response> {
  const targetUrl = upstream + targetPath + search;

  try {
    // 1. 白名单检查
    if (!isWhitelisted(targetPath)) {
      return jsonResponse({ 
        error: "Forbidden", 
        message: "Repository not in whitelist",
        repo: extractRepo(targetPath)
      }, 403);
    }

    // 2. 黑名单检查
    if (isBlacklisted(targetPath)) {
      return jsonResponse({ 
        error: "Forbidden", 
        message: "Repository is blacklisted",
        repo: extractRepo(targetPath)
      }, 403);
    }

    // 3. jsDelivr 加速（小文件）
    const url = new URL(targetUrl);
    if (shouldUseJsDelivr(url)) {
      const jsDelivrUrl = convertToJsDelivr(url);
      if (jsDelivrUrl) {
        return new Response(null, {
          status: 302,
          headers: { location: jsDelivrUrl }
        });
      }
    }

    // 4. 流式转发
    const headers = stripRequestHeaders(req.headers);
    headers.set("host", url.host);

    const resp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      redirect: "manual",
    });

    // 5. 大小检查（如果 Content-Length 存在）
    const contentLength = resp.headers.get("content-length");
    if (contentLength && CONFIG.SIZE_LIMIT > 0) {
      const sizeGB = parseInt(contentLength) / (1024 * 1024 * 1024);
      if (sizeGB > CONFIG.SIZE_LIMIT) {
        return new Response(null, {
          status: 302,
          headers: { location: targetUrl }
        });
      }
    }

    // 6. 处理重定向
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

    // 7. 流式透传（关键：不缓冲，直接传递 body）
    const newResp = new Response(resp.body, { status: resp.status });
    
    // 8. 添加缓存头（对 Release 文件）
    if (CONFIG.CACHE_RELEASE && targetPath.includes("/releases/download/")) {
      newResp.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
    
    copyHeaders(resp.headers, newResp.headers);
    
    // 添加 CORS 头
    newResp.headers.set("Access-Control-Allow-Origin", "*");

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

// Docker Registry 代理
export async function handleDockerProxy(
  req: Request,
  path: string,
  search: string,
  dockerHub: string,
  dockerAuth: string
): Promise<Response> {
  const targetUrl = dockerHub + path + search;

  let resp = await fetch(targetUrl, {
    method: req.method,
    headers: stripRequestHeaders(req.headers),
    redirect: "manual",
  });

  if (resp.status === 401) {
    const authHeader = resp.headers.get("www-authenticate");
    if (authHeader) {
      const { realm, service, scope } = parseDockerAuth(authHeader);
      
      const tokenUrl = new URL(realm);
      if (service) tokenUrl.searchParams.set("service", service);
      if (scope) tokenUrl.searchParams.set("scope", scope);
      
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

        const headers = stripRequestHeaders(req.headers);
        headers.set("authorization", `Bearer ${bearer}`);
        
        resp = await fetch(targetUrl, {
          method: req.method,
          headers,
          redirect: "manual",
        });
      }
    }
  }

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

  const newResp = new Response(resp.body, { status: resp.status });
  copyHeaders(resp.headers, newResp.headers);

  return newResp;
}

function parseDockerAuth(header: string): { realm: string; service?: string; scope?: string } {
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
  try {
    const url = new URL(location);
    
    if (url.host === "registry-1.docker.io") {
      return "/v2/" + url.pathname.slice(4) + url.search;
    }
    
    if (url.host === "auth.docker.io") {
      return "/auth/" + url.pathname + url.search;
    }
    
    return location;
  } catch {
    return location;
  }
}

function rewriteLocation(location: string): string {
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
    
    if (url.host === "objects.githubusercontent.com") {
      return "/objects/" + url.pathname + url.search;
    }
    
    if (url.host === "release-assets.githubusercontent.com") {
      return "/release-assets/" + url.pathname + url.search;
    }
    
    return location;
  } catch {
    return location;
  }
}
