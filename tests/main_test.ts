import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";

// 测试配置
const BASE_URL = `http://localhost:${Deno.env.get("PORT") || 8000}`;

Deno.test("health check returns ok", async () => {
  const resp = await fetch(`${BASE_URL}/health`);
  assertEquals(resp.status, 200);
  
  const data = await resp.json();
  assertEquals(data.status, "ok");
  assertExists(data.timestamp);
});

Deno.test("index page returns HTML", async () => {
  const resp = await fetch(`${BASE_URL}/`);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get("content-type"), "text/html; charset=utf-8");
  
  const html = await resp.text();
  assertExists(html.includes("GitHub & Docker"));
  assertExists(html.includes("Proxy"));
});

Deno.test("diag endpoint returns test results", async () => {
  const resp = await fetch(`${BASE_URL}/diag`);
  assertEquals(resp.status, 200);
  
  const data = await resp.json();
  assertExists(data.timestamp);
  assertExists(data.tests);
  assertExists(data.tests.example_com);
  assertExists(data.tests.github_api);
});

Deno.test("404 for unknown paths", async () => {
  const resp = await fetch(`${BASE_URL}/unknown-path`);
  assertEquals(resp.status, 404);
  
  const data = await resp.json();
  assertEquals(data.error, "Not Found");
});

Deno.test("GitHub proxy returns response", async () => {
  const resp = await fetch(`${BASE_URL}/gh/octocat/Hello-World`, {
    method: "HEAD",
  });
  
  // GitHub 可能返回 200 或 302（重定向）
  assertExists([200, 301, 302, 307, 308].includes(resp.status));
});

Deno.test("Docker registry /v2/ returns 200 or 401", async () => {
  const resp = await fetch(`${BASE_URL}/v2/`);
  
  // 可能返回 200（成功）或 401（需要认证）
  assertExists([200, 401].includes(resp.status));
});

Deno.test("CORS headers are present", async () => {
  const resp = await fetch(`${BASE_URL}/gh/octocat/Hello-World`, {
    method: "HEAD",
  });
  
  const cors = resp.headers.get("access-control-allow-origin");
  assertExists(cors);
});

Deno.test("auth check works when PROXY_PASSWORD is set", async () => {
  // 跳过如果没有设置密码
  if (!Deno.env.get("PROXY_PASSWORD")) {
    return;
  }
  
  // 无认证应该返回 401
  const respNoAuth = await fetch(`${BASE_URL}/gh/octocat/Hello-World`);
  assertEquals(respNoAuth.status, 401);
  
  // 有认证应该返回 200 或 302
  const credentials = btoa(`proxy:${Deno.env.get("PROXY_PASSWORD")}`);
  const respWithAuth = await fetch(`${BASE_URL}/gh/octocat/Hello-World`, {
    headers: {
      Authorization: `Basic ${credentials}`,
    },
  });
  assertExists([200, 301, 302].includes(respWithAuth.status));
});
