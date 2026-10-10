// 工具函数

import { CONFIG } from "./config.ts";

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// 门禁与上游共用 HTTP 头，所以门禁另开一个头：客户端把 authorization 留给
// git PAT / registry bearer，把代理密码放 x-proxy-key，两者不再互斥
export const PROXY_KEY_HEADER = "x-proxy-key";

const GATE_CHALLENGE = { "www-authenticate": 'Basic realm="proxy"' };

function proxyBasic(password: string): string {
  return "Basic " + btoa(`proxy:${password}`);
}

export function checkAuth(req: Request): Response | null {
  const password = CONFIG.PROXY_PASSWORD;
  if (!password) return null; // 未设置密码，允许访问

  const proxyKey = req.headers.get(PROXY_KEY_HEADER);
  if (proxyKey) {
    return proxyKey === password ? null : new Response("Forbidden", { status: 403 });
  }

  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Basic ")) {
    return new Response("Unauthorized", { status: 401, headers: GATE_CHALLENGE });
  }

  if (auth !== proxyBasic(password)) {
    return new Response("Forbidden", { status: 403 });
  }

  return null;
}

// 门禁凭据不认作上游凭据：转发它等于把代理密码送给第三方，
// 且会顶掉客户端真正想带的上游鉴权头
export function isProxyGateCredential(value: string): boolean {
  const password = CONFIG.PROXY_PASSWORD;
  return !!password && value === proxyBasic(password);
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
  // content-encoding/length 需剥离:fetch 已解压响应体,原样透传会让客户端二次解码失败
  const skipSet = new Set([
    "host", "content-length", "content-encoding", "transfer-encoding", "connection",
    ...skip.map(s => s.toLowerCase())
  ]);
  
  from.forEach((value, key) => {
    if (!skipSet.has(key.toLowerCase())) {
      to.set(key, value);
    }
  });
}

// 统计真实写出字节：代理响应是透传流，且 copyHeaders 会剥掉 content-length，
// 因此不能从响应头取流量，必须在流上逐块累加。
export function countOutboundBytes(response: Response): {
  response: Response;
  settled: Promise<number>;
} {
  if (!response.body) return { response, settled: Promise.resolve(0) };

  let total = 0;
  let settle: (n: number) => void = () => {};
  const settled = new Promise<number>((resolve) => {
    settle = resolve;
  });

  // 客户端中断时只触发 cancel 不触发 flush；再加超时兜底，计数不悬挂
  const timer = setTimeout(() => settle(total), 60_000);
  const done = () => {
    clearTimeout(timer);
    settle(total);
  };

  // lib.dom 的 Transformer 类型未声明 cancel，但客户端中断时运行时只会调 cancel
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(
      chunk: Uint8Array,
      controller: TransformStreamDefaultController<Uint8Array>
    ) {
      total += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush: done,
    cancel: done,
  } as any);

  const wrapped = new Response(response.body.pipeThrough(counter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  return { response: wrapped, settled };
}

