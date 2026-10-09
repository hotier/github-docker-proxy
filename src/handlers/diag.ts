// 诊断端点

import { jsonResponse } from "../utils/helpers.ts";

export async function diagnosticEndpoint(): Promise<Response> {
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
