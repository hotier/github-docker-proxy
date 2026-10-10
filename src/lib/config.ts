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
  
  // 白名单/黑名单（JSON 格式环境变量）
  // 例如: WHITE_LIST=["hotier/*","octocat/Hello-World"]
  WHITE_LIST: JSON.parse(getEnv("WHITE_LIST") || "[]"),
  BLACK_LIST: JSON.parse(getEnv("BLACK_LIST") || "[]"),
  
  // 大小限制（GB），超过则重定向到原始 URL
  SIZE_LIMIT: parseInt(getEnv("SIZE_LIMIT") || "999"),
  
  // 是否启用 jsDelivr 加速（小文件）
  USE_JSDELIVR: getEnv("USE_JSDELIVR") === "true",
  
  // 速率限制（每分钟请求数，0 表示不限制）
  RATE_LIMIT: parseInt(getEnv("RATE_LIMIT") || "0"),
  
  // 缓存控制
  CACHE_RELEASE: getEnv("CACHE_RELEASE") !== "false", // 默认开启
  
  // 版本号
  VERSION: "1.0.0",
};

// 检查仓库是否在白名单中
export function isWhitelisted(path: string): boolean {
  if (CONFIG.WHITE_LIST.length === 0) return true;
  
  const match = path.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return true;
  
  const repo = `${match[1]}/${match[2]}`;
  return CONFIG.WHITE_LIST.some((pattern: string) => {
    // 支持通配符，如 "hotier/*"
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$", "i");
    return regex.test(repo);
  });
}

// 检查仓库是否在黑名单中
export function isBlacklisted(path: string): boolean {
  if (CONFIG.BLACK_LIST.length === 0) return false;
  
  const match = path.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return false;
  
  const repo = `${match[1]}/${match[2]}`;
  return CONFIG.BLACK_LIST.some((pattern: string) => {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$", "i");
    return regex.test(repo);
  });
}

// 检查是否应该使用 jsDelivr 加速
export function shouldUseJsDelivr(url: URL): boolean {
  if (!CONFIG.USE_JSDELIVR) return false;
  
  // 只对 raw 文件和 blob 文件使用 jsDelivr
  return url.hostname === "raw.githubusercontent.com" || 
         (url.hostname === "github.com" && url.pathname.includes("/blob/"));
}

// 转换为 jsDelivr URL
export function convertToJsDelivr(url: URL): string | null {
  // 模式 1: github.com/owner/repo/raw/branch/path
  // 模式 2: github.com/owner/repo/blob/branch/path
  // 模式 3: raw.githubusercontent.com/owner/repo/branch/path
  
  const patterns = [
    /github\.com\/([^\/]+)\/([^\/]+)\/(?:raw|blob)\/([^\/]+)\/(.+)/,
    /raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.pathname.match(pattern);
    if (match) {
      const [, owner, repo, branch, path] = match;
      return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`;
    }
  }
  
  return null;
}

