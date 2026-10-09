// 通用工具函数

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export function checkAuth(req: Request): Response | null {
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

export function filterHeaders(headers: Headers): Headers {
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

export function copyHeaders(from: Headers, to: Headers, skip: string[] = []) {
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
