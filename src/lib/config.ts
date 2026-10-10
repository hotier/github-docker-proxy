// 配置文件
// 注意：在 Astro 中使用 import.meta.env，在 Deno 中使用 Deno.env

const getEnv = (key: string): string => {
  // @ts-ignore
  if (typeof Deno !== 'undefined') {
    try {
      // @ts-ignore
      return Deno.env.get(key) || '';
    } catch {
      // 无 env 权限时回退到其他来源
    }
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key] || '';
  }
  // @ts-ignore
  return import.meta.env[key] || '';
};

export const CONFIG = {
  // 访问控制
  PROXY_PASSWORD: getEnv("PROXY_PASSWORD"),

  // Docker Hub 私有仓库凭据（拉取时用于换取 token）
  DOCKER_HUB_USERNAME: getEnv("DOCKER_HUB_USERNAME"),
  DOCKER_HUB_PASSWORD: getEnv("DOCKER_HUB_PASSWORD"),

  // GitHub API token：出口 IP 是平台共享的，匿名 60 次/时早被别的租户耗尽，
  // 注入后配额升到 5000 次/时
  GITHUB_TOKEN: getEnv("GITHUB_TOKEN"),
  
  // 大小限制（GB），超过则重定向到原始 URL
  SIZE_LIMIT: parseInt(getEnv("SIZE_LIMIT") || "999"),
  
  // 速率限制（每分钟请求数，0 表示不限制）
  RATE_LIMIT: parseInt(getEnv("RATE_LIMIT") || "0"),
  
  // 版本号
  VERSION: "1.0.0",
};
