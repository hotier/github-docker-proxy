// 增强的代理请求处理器（参考 hunshcn/gh-proxy）

import { CONFIG, isWhitelisted, isBlacklisted, shouldUseJsDelivr, convertToJsDelivr } from "./config";
import { PREFIX_BY_UPSTREAM, rewriteHostsOf } from "./services";
import { jsonResponse, filterHeaders, copyHeaders } from "./helpers";

// 正文改写需缓冲整个响应，给体积设上限，超限直接流式透传
const TEXT_REWRITE_LIMIT = 32 * 1024 * 1024;

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
  filtered.set("user-agent", "swiftorigin/1.0");
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
  const targetUrl = `${upstream.replace(/\/+$/, "")}/${targetPath.replace(/^\/+/, "")}${search}`;

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
        const newLocation = rewriteLocation(location, upstream);
        const newResp = new Response(null, { status: resp.status });
        newResp.headers.set("location", newLocation);
        copyHeaders(resp.headers, newResp.headers, ["location"]);
        return newResp;
      }
    }

    // 6.5 正文改写(注册表 rewriteHosts 声明的上游)：把元数据/索引页里的绝对 URL 换成本代理前缀，
    // 后续 tarball/wheel 下载即走加速通道；sha256、integrity 等校验值与 URL 无关，不受影响
    const rewriteHosts = rewriteHostsOf(url.origin);
    const contentType = resp.headers.get("content-type") || "";
    if (rewriteHosts && resp.ok && /json|html/.test(contentType)) {
      const encodedLen = parseInt(resp.headers.get("content-length") || "0");
      if (!encodedLen || encodedLen <= TEXT_REWRITE_LIMIT) {
        const proxyOrigin = new URL(req.url).origin;
        let rewritten = await resp.text();
        for (const host of rewriteHosts) {
          const prefix = PREFIX_BY_UPSTREAM[host];
          if (!prefix) continue;
          // 先替换带斜杠的形式(host + path)，再把裸 host 换成不带尾斜杠的前缀，避免产生双斜杠
          rewritten = rewritten.split(`${host}/`).join(proxyOrigin + prefix);
          rewritten = rewritten.split(host).join(proxyOrigin + prefix.replace(/\/+$/, ""));
        }
        const textResp = new Response(rewritten, { status: resp.status });
        copyHeaders(resp.headers, textResp.headers);
        textResp.headers.set("Access-Control-Allow-Origin", "*");
        return textResp;
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
    
    // 网络错误（如本地无法访问 GitHub）
    if (error.message?.includes('fetch failed') || error.message?.includes('SSL')) {
      return jsonResponse({ 
        error: "Network Error", 
        message: "无法连接到目标服务器（可能是本地网络问题）",
        target: targetUrl,
        hint: "This works in production (Deno Deploy) but may fail in local development due to network restrictions."
      }, 502);
    }
    
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
      
      const dockerUser = CONFIG.DOCKER_HUB_USERNAME;
      const dockerPass = CONFIG.DOCKER_HUB_PASSWORD;
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
    
    return location;
  } catch {
    return location;
  }
}

function rewriteLocation(location: string, upstream: string): string {
  try {
    // 相对 Location（unpkg 的版本解析 302 只给 /mime@4.1.0/...）必须按上游解析，
    // 否则浏览器把它拼到本代理根路径，下一跳直接 404
    const url = new URL(location, upstream.replace(/\/+$/, '') + '/');

    // 上游 origin -> 本代理前缀，映射与路由同源(src/lib/services)，避免两边前缀漂移导致重写后 404
    for (const [origin, prefix] of Object.entries(PREFIX_BY_UPSTREAM)) {
      if (url.origin === origin) {
        // 前缀自带尾斜杠、pathname 自带首斜杠，去其一避免产生 // 路径
        return `${prefix.replace(/\/+$/, '')}${url.pathname}${url.search}`;
      }
    }

    return location;
  } catch {
    return location;
  }
}



