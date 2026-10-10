// 上游服务注册表：前缀 -> 上游 -> 服务标签的唯一来源
// 路由(src/pages/api/[...path].ts)、鉴权与统计分类(src/middleware.ts)、
// 重定向反向映射(src/lib/proxy.ts)、状态看板与统计维度都从这里派生
// 新增一个加速服务 = 在此加一行 + 状态页/文档按需补充，不必再改多处硬编码

export type Service =
  | 'github'
  | 'docker'
  | 'npm'
  | 'go'
  | 'jsd'
  | 'unpkg'
  | 'maven'
  | 'mcr'
  | 'pypi';

export type Route = {
  prefix: string;
  upstream: string;
  service: Service;
  // api: 走 /api/* 通用前缀透传；v2: 由 src/pages/v2/[...path].ts 处理 registry 协议与 token 流程
  handler?: 'api' | 'v2';
  // 该上游会在 HTML/JSON 正文里给出这些 host 的绝对 URL，不改写则客户端绕过代理直连源站；
  // 列出的 host 会被替换成各自在注册表里的本代理前缀
  rewriteHosts?: string[];
  // 同一服务的其他等价域名（镜像源、旧域名），仅用于「域名 -> 前缀」映射
  aliases?: string[];
};

export const ROUTES: Route[] = [
  // GitHub
  { prefix: '/api/gh/', upstream: 'https://github.com', service: 'github' },
  { prefix: '/api/ghraw/', upstream: 'https://raw.githubusercontent.com', service: 'github' },
  { prefix: '/api/codeload/', upstream: 'https://codeload.github.com', service: 'github' },
  { prefix: '/api/objects/', upstream: 'https://objects.githubusercontent.com', service: 'github' },
  { prefix: '/api/release-assets/', upstream: 'https://release-assets.githubusercontent.com', service: 'github' },
  { prefix: '/api/api.github.com/', upstream: 'https://api.github.com', service: 'github' },
  { prefix: '/api/avatars/', upstream: 'https://avatars.githubusercontent.com', service: 'github' },

  // 容器镜像仓库：客户端把 {域名}/api/ghcr 这类前缀当作仓库地址前缀，daemon 会请求 {前缀}/v2/...
  { prefix: '/v2/', upstream: 'https://registry-1.docker.io', service: 'docker', handler: 'v2', aliases: ['docker.io'] },
  { prefix: '/api/ghcr/', upstream: 'https://ghcr.io', service: 'docker' },
  { prefix: '/api/gcr/', upstream: 'https://gcr.io', service: 'docker' },
  { prefix: '/api/k8s/', upstream: 'https://registry.k8s.io', service: 'docker' },
  { prefix: '/api/quay/', upstream: 'https://quay.io', service: 'docker' },
  { prefix: '/api/mcr/', upstream: 'https://mcr.microsoft.com', service: 'mcr' },

  // 包管理与前端资源
  {
    prefix: '/api/npm/',
    upstream: 'https://registry.npmjs.org',
    service: 'npm',
    // 包元数据里的 tarball 绝对 URL 指向本上游，不改写则下载绕过代理
    rewriteHosts: ['https://registry.npmjs.org'],
    aliases: ['registry.npmmirror.com'],
  },
  { prefix: '/api/goproxy/', upstream: 'https://proxy.golang.org', service: 'go' },
  { prefix: '/api/jsd/', upstream: 'https://cdn.jsdelivr.net', service: 'jsd' },
  // unpkg 的版本区间解析是同源 302，Location 由注册表反写回本代理，无需正文改写
  { prefix: '/api/unpkg/', upstream: 'https://unpkg.com', service: 'unpkg' },
  { prefix: '/api/maven/', upstream: 'https://repo1.maven.org', service: 'maven' },
  { prefix: '/api/gmaven/', upstream: 'https://dl.google.com', service: 'maven' },
  // PyPI：simple 索引(HTML/JSON)与包 JSON 都内嵌 files 域的绝对下载地址，必须改写才有加速意义
  {
    prefix: '/api/pypi/',
    upstream: 'https://pypi.org',
    service: 'pypi',
    rewriteHosts: ['https://pypi.org', 'https://files.pythonhosted.org'],
  },
  { prefix: '/api/pyf/', upstream: 'https://files.pythonhosted.org', service: 'pypi' },
];

export const SERVICE_NAMES: Service[] = [...new Set(ROUTES.map((route) => route.service))];

const API_ROUTES = ROUTES.filter((route) => (route.handler ?? 'api') === 'api');

// 最长前缀优先，避免将来出现互为前缀的端点时匹配错位
function match<T extends { prefix: string }>(routes: T[], path: string): T | null {
  let best: T | null = null;
  for (const route of routes) {
    if (path.startsWith(route.prefix) && (!best || route.prefix.length > best.prefix.length)) {
      best = route;
    }
  }
  return best;
}

export function findApiRoute(path: string): Route | null {
  return match(API_ROUTES, path);
}

// 鉴权与统计的分类口径：与路由同源，避免「能代理但不计数/不鉴权」的漏网前缀
export function serviceOf(path: string): Service | null {
  return match(ROUTES, path)?.service ?? null;
}

// 「使用次数」口径：一次真正拿到内容的取用算一次，协议握手/元数据/网页浏览/中转跳不计。
// 与 req（HTTP 请求数）并列为独立计数器，状态看板展示这个。
// 中转规则：代理会把上游 302 的 Location 改写回本代理（如 gh 下载 302 -> /api/objects/），
// 这类同站跳不计，等落地的那一跳计；而回源站的绝对地址 302（SIZE_LIMIT）
// 意味着下载在代理外完成，这就是终跳，计一次。
export function isUsageRequest(
  service: Service,
  pathname: string,
  search: string,
  status: number,
  location: string | null,
  proxyOrigin: string
): boolean {
  if (status >= 400) return false;

  let pathIsUsage: boolean;
  switch (service) {
    case 'github':
      pathIsUsage =
        (pathname.startsWith('/api/gh/') &&
          (pathname.includes('/releases/download/') ||
            pathname.includes('/archive/') ||
            (pathname.endsWith('/info/refs') && search.includes('service=git-')))) ||
        pathname.startsWith('/api/ghraw/') ||
        pathname.startsWith('/api/codeload/') ||
        pathname.startsWith('/api/objects/') ||
        pathname.startsWith('/api/release-assets/');
      break;
    case 'docker':
    case 'mcr':
      // 一次 pull 拆成 manifest + 每层 blob，只数 manifest ≈「拉了一个镜像」
      pathIsUsage = pathname.includes('/manifests/');
      break;
    case 'npm':
      pathIsUsage = pathname.endsWith('.tgz');
      break;
    case 'go':
      pathIsUsage = pathname.includes('/@v/') && pathname.endsWith('.zip');
      break;
    case 'pypi':
      // simple 索引与包 JSON 是元数据，文件下载走 pyf 前缀
      pathIsUsage = pathname.startsWith('/api/pyf/');
      break;
    case 'jsd':
    case 'unpkg': {
      // 资源本体：带版本(@)且最后一段是文件名；目录列举与解析 302 不算
      const last = pathname.slice(pathname.lastIndexOf('/') + 1);
      pathIsUsage = !pathname.endsWith('/') && pathname.includes('@') && last.includes('.');
      break;
    }
    case 'maven':
      pathIsUsage = /\.(jar|aar|war)$/i.test(pathname);
      break;
    default:
      pathIsUsage = false;
  }
  if (!pathIsUsage) return false;

  if (status === 200 || status === 206) return true;
  if ([301, 302, 307, 308].includes(status)) {
    // 无 Location 或指回本站 = 中转；外部绝对地址 = 回源终跳
    if (!location) return false;
    return !(location.startsWith('/') || location.startsWith(proxyOrigin));
  }
  return false;
}

// 上游 origin -> 本代理前缀，用于把上游 302 的 Location 改写回代理路径
export const PREFIX_BY_UPSTREAM: Record<string, string> = Object.fromEntries(
  API_ROUTES.map((route) => [route.upstream, route.prefix])
);

// 响应体改写：origin -> 需要替换成代理地址的 host 列表
const REWRITE_BY_UPSTREAM: Record<string, string[]> = Object.fromEntries(
  API_ROUTES.filter((route) => route.rewriteHosts?.length).map((route) => [
    route.upstream,
    route.rewriteHosts!,
  ])
);

export function rewriteHostsOf(origin: string): string[] | null {
  return REWRITE_BY_UPSTREAM[origin] ?? null;
}

// 域名(上游 host + 等价别名) -> 本代理前缀(不含尾斜杠)，首页 URL 转换器据此生成加速链接
export const PREFIX_BY_HOST: Record<string, string> = Object.fromEntries(
  ROUTES.flatMap((route) => {
    const prefix = route.prefix.replace(/\/+$/, '');
    return [new URL(route.upstream).host, ...(route.aliases ?? [])].map(
      (host) => [host, prefix] as [string, string]
    );
  })
);
