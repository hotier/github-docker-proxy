// 增强的代理请求处理器（参考 hunshcn/gh-proxy）

import { CONFIG } from "./config.ts";
import { PREFIX_BY_UPSTREAM, rewriteHostsOf } from "./services.ts";
import { jsonResponse, filterHeaders, copyHeaders, PROXY_KEY_HEADER, isProxyGateCredential } from "./helpers.ts";

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

// GITHUB_TOKEN 只补到公开仓库元数据与配额端点：/user、/notifications、/gists
// 这类账号端点会用 token 主人的身份返回数据，代理是公开的，等于把账号信息开放给所有访客
const TOKEN_INJECT_PATH = /^\/(repos\/[^/]+\/[^/]+|rate_limit)(\/|\?|$)/;

// 上游用注入身份应答时会回显该身份的 scope，不属于客户端该看的东西
const ECHOED_IDENTITY_HEADERS = ['x-oauth-scopes', 'x-accepted-oauth-scopes'];

// 剥离请求中的 hop-by-hop 头
function stripRequestHeaders(headers: Headers): Headers {
  const filtered = new Headers();
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.includes(lower)) return;
    // 门禁凭据止于本代理：既不外泄密码，也不顶掉客户端带给上游的鉴权头
    if (lower === PROXY_KEY_HEADER) return;
    if (lower === "authorization" && isProxyGateCredential(value)) return;
    filtered.set(key, value);
  });
  // 设置 User-Agent（GitHub API 要求）
  filtered.set("user-agent", "swiftorigin/1.0");
  return filtered;
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
    const url = new URL(targetUrl);

    // 流式转发
    const headers = stripRequestHeaders(req.headers);
    headers.set("host", url.host);

    // 共享出口 IP 的匿名配额(60/h)常被别的租户耗尽，配置 GITHUB_TOKEN 后补上身份。
    // 只补只读方法且只补公开仓库/配额端点：代理是公开的，借这个身份发写请求或读账号端点
    // 等于替陌生人操作账号、把账号数据开放给所有访客
    const injectToken =
      !!CONFIG.GITHUB_TOKEN &&
      url.host === "api.github.com" &&
      (req.method === "GET" || req.method === "HEAD") &&
      !headers.get("authorization") &&
      TOKEN_INJECT_PATH.test(url.pathname);

    if (injectToken) {
      headers.set("authorization", `Bearer ${CONFIG.GITHUB_TOKEN}`);
    }

    // 谁的凭据取回的响应，就只能给谁：公共缓存(CDN)的缓存键不含 authorization，
    // 带上游 token 拿回的私有内容一旦被按裸 URL 存下来，就会喂给后续的匿名请求。
    // x-proxy-key 与 Basic proxy:<密码> 是全站门禁，用它们取回的内容对所有已授权
    // 访客都一样，不算私有
    const clientCredential = req.headers.get("authorization");
    const underCredential =
      (clientCredential !== null && !isProxyGateCredential(clientCredential)) || injectToken;
    const privacyHeaders = (res: Response) => {
      if (underCredential) res.headers.set("Cache-Control", "private, no-store");
      return res;
    };

    // git-upload-pack 等带体请求走 fetch 转发:流式 body 必须声明 duplex,
    // 否则 fetch 直接拒绝(500),git clone / POST 类请求全部失败
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;

    const resp = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: "manual",
      // 客户端断开即停止搬运：不接 signal 时上游整份响应仍会被读完，白烧出口额度与 CPU
      signal: req.signal,
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);

    // 1. 大小检查（如果 Content-Length 存在）
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

    // 2. 处理重定向
    if ([301, 302, 307, 308].includes(resp.status)) {
      const location = resp.headers.get("location");
      if (location) {
        const newLocation = rewriteLocation(location, upstream);
        const newResp = new Response(null, { status: resp.status });
        newResp.headers.set("location", newLocation);
        copyHeaders(resp.headers, newResp.headers, ["location"]);
        return privacyHeaders(newResp);
      }
    }

    // 3. 正文改写(注册表 rewriteHosts 声明的上游)：把元数据/索引页里的绝对 URL 换成本代理前缀，
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
        return privacyHeaders(textResp);
      }
    }

    // 4. 流式透传（关键：不缓冲，直接传递 body）
    const newResp = new Response(resp.body, { status: resp.status });
    copyHeaders(resp.headers, newResp.headers, injectToken ? ECHOED_IDENTITY_HEADERS : []);

    // 添加 CORS 头
    newResp.headers.set("Access-Control-Allow-Origin", "*");

    return privacyHeaders(newResp);
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

  // push 的 blob 上传是带体请求：不转发 body 上游会收到空请求。
  // body 是流，读一次即耗尽，故 401 后的重试只对无体请求（pull）成立
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;

  let resp = await fetch(targetUrl, {
    method: req.method,
    headers: stripRequestHeaders(req.headers),
    body: hasBody ? req.body : undefined,
    redirect: "manual",
    signal: req.signal,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);

  if (resp.status === 401 && !hasBody) {
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
          signal: req.signal,
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



