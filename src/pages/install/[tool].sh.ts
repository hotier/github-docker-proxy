import type { APIRoute } from 'astro';

// 一键配置脚本，供文档页与 README 里的 `curl -fsSL …/install/<tool>.sh | sh` 使用。
// 按请求 origin 生成而不是放 public/ 静态文件：同一份代码部署到任何域名都指向正确前缀。
// 只收录能用一条命令安全写入自身配置的生态；Docker 要 root 改 /etc/docker/daemon.json、
// Maven 要写 settings.xml，覆盖他人已有配置的风险大于收益，页面上保留手工步骤。

// origin 会被写进用户要执行的脚本，只接受可信形态：https 主机名，或本地 http
const SAFE_ORIGIN =
  /^https:\/\/[a-z0-9.-]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const header = (tool: string, base: string) =>
  `#!/bin/sh\n# SwiftOrigin ${tool} 加速配置（生成自 ${base}）\n`;

const SCRIPTS: Record<string, (base: string) => string> = {
  npm: (base) => {
    const registry = `${base}/api/npm/`;
    return `${header('npm', base)}
registry="${registry}"

if command -v npm >/dev/null 2>&1; then
  npm config set registry "$registry" && echo "npm  registry -> $registry"
else
  echo "未找到 npm，跳过" >&2
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm config set registry "$registry" >/dev/null 2>&1 && echo "pnpm registry -> $registry"
fi

if command -v yarn >/dev/null 2>&1; then
  yarn config set registry "$registry" >/dev/null 2>&1 && echo "yarn registry -> $registry" ||
    echo "yarn 未自动配置（Yarn 4 请用：yarn config set npmRegistryServer $registry）"
fi

echo
echo "验证： npm config get registry"
echo "还原： npm config set registry https://registry.npmjs.org/"
`;
  },

  pypi: (base) => {
    const index = `${base}/api/pypi/simple/`;
    return `${header('PyPI', base)}
index="${index}"

if command -v pip >/dev/null 2>&1; then pip_bin="pip"
elif command -v pip3 >/dev/null 2>&1; then pip_bin="pip3"
elif command -v python3 >/dev/null 2>&1; then pip_bin="python3 -m pip"
else
  echo "未找到 pip" >&2
  exit 1
fi

if $pip_bin config set global.index-url "$index" >/dev/null 2>&1; then
  echo "pip index-url -> $index"
else
  # pip config 子命令要 pip 23.1+，旧版退回环境变量
  echo "当前 pip 不支持 config 子命令，请改用环境变量："
  echo "  export PIP_INDEX_URL=$index"
fi

echo
echo "uv 读同一个变量： export PIP_INDEX_URL=$index"
echo "验证： $pip_bin config get global.index-url"
echo "还原： $pip_bin config unset global.index-url"
`;
  },

  go: (base) => {
    const goproxy = `${base}/api/goproxy/`;
    return `${header('Go Modules', base)}
if ! command -v go >/dev/null 2>&1; then
  echo "未找到 go" >&2
  exit 1
fi

go env -w GOPROXY=${goproxy},direct && echo "GOPROXY -> ${goproxy},direct"

echo
echo "验证： go env GOPROXY"
echo "还原： go env -u GOPROXY"
`;
  },

  git: (base) => {
    const gh = `${base}/api/gh/`;
    return `${header('GitHub clone', base)}
if ! command -v git >/dev/null 2>&1; then
  echo "未找到 git" >&2
  exit 1
fi

git config --global url."${gh}".insteadOf "https://github.com/" \\
  && echo "https://github.com/... 的 git 操作 -> ${gh}..."

echo
echo "只影响 https://github.com/ 前缀的 git 操作，网页与 raw 链接不变。"
echo "验证： git config --global --get-regexp insteadOf"
echo "还原： git config --global --unset url.\\"${gh}\\".insteadOf"
`;
  },
};

export const GET: APIRoute = async ({ params, request }) => {
  const plain = { headers: { 'content-type': 'text/plain; charset=utf-8' } };
  const tool = params.tool ?? '';
  const build = Object.hasOwn(SCRIPTS, tool) ? SCRIPTS[tool] : undefined;

  if (!build) {
    return new Response(
      `未知脚本：${tool}\n可用：${Object.keys(SCRIPTS).join(', ')}\n`,
      { status: 404, ...plain }
    );
  }

  const base = new URL(request.url).origin;
  if (!SAFE_ORIGIN.test(base)) {
    return new Response('无法从请求推导安全的脚本地址\n', { status: 500, ...plain });
  }

  return new Response(build(base), { status: 200, ...plain });
};
