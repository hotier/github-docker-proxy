<p align="center">
  <img src="public/icons/icon-192.png" width="96" height="96" alt="迅源 SwiftOrigin 标识">
</p>

# 迅源 SwiftOrigin

> 加速一切开发资源的取用路径。

基于 [Deno Deploy](https://deno.com/deploy) + Astro SSR 的边缘加速代理，面向中国大陆网络环境：把 GitHub、Docker 镜像仓库与主流包管理器的源站路径改写到离你最近的一侧，粘贴链接即可生成加速地址。

站点内建四个入口：`/` 链接转换、`/github`、`/docker`、`/packages` 用法说明、`/status` 节点状态与流量统计。

## 特性

- GitHub：Release 下载、Raw 文件、Archive、仓库页面、api.github.com、git clone 加速
- Docker：Docker Hub（registry-mirrors 直接可用）、GHCR、GCR、registry.k8s.io、Quay、MCR 加速
- Packages：npm（registry.npmjs.org 官方源，元数据内 tarball 绝对 URL 自动重写回本代理）、Go Modules（proxy.golang.org，含 sumdb 校验库转发）、jsDelivr 与 unpkg CDN、Maven Central / Google Maven、PyPI（pypi.org 官方源，simple 索引内的 files.pythonhosted.org 下载地址重写回本代理）加速
- 流式转发，不缓冲大文件
- Docker Hub Token 自动换取（支持配置私有账号提升限速）
- 访问鉴权（可选，只保护代理路径，说明页面对外开放）：`Authorization: Basic proxy:<密码>` 或 `x-proxy-key: <密码>`
- 访问与流量统计（按 github / docker / npm / go / jsd / unpkg / maven / mcr / pypi / 站点服务维度；生产使用 Deno KV，开发使用内存）。每服务两个计数：HTTP 请求数与「使用次数」——后者按一次下载/拉取算一次（GitHub Release/raw/archive/clone、镜像 manifest、npm tarball、Go module zip、PyPI 文件、CDN 资源、Maven jar，规则见 `src/lib/services.ts` 的 `isUsageRequest`），状态页表格展示的是使用次数（列名写作「今日请求 / 累计请求」）
- 毛玻璃（glassmorphism）界面，亮/暗/跟随系统主题，无闪烁
- 构建期图标引擎（better-icons + Iconify），零客户端 JS、零外部字体依赖

## 品牌

| 项 | 值 |
|----|----|
| 名称 | 迅源 / SwiftOrigin |
| 主张 | 加速一切开发资源的取用路径 |
| 标识 | 加速箭头穿出开口轨道：轨道是源站与边缘层，箭头是路径改写 |
| 主色 | `#006780`（亮）/ `#62D4FF`（暗） |
| 图标底板 | 渐变 `#00A6CE` → `#00495C`，标识反白 |
| 页面底色 | `#e3f2f8`（亮）/ `#060d14`（暗），与 `theme-color`、manifest 一致 |
| 字体 | 本地系统字体栈，不引入外部字体 |

- 文案与主题色常量集中在 `src/lib/brand.ts`，导航、页脚、404、OG 标签同源。
- 标识以低透明度水印融进首页转换器卡片与 404 背景，不单独占版面；裁切要放在独立的 `absolute inset-0 overflow-hidden` 层上，父卡片加 `overflow-hidden` 会剪掉转换器的下拉菜单。
- 标识图形源文件：`src/components/BrandMark.astro`（网页内，`currentColor` 单色）与 `public/favicon.svg`（带底板图标）、`public/og-image.svg`（分享图版式）。
- 仓库无图形工具链（`build:css` 之外的位图不自动生成）。改动 `favicon.svg` / `og-image.svg` 后，需用浏览器把 SVG 栅格化为位图再落盘：`new Image()` 载入 SVG → `canvas.drawImage` → `toDataURL()`，导出 `apple-touch-icon.png`(180)、`icons/icon-192.png`、`icons/icon-512.png`、`og-image.jpg`(1200x630)，并按 16/32 两档 PNG 组装 `favicon.ico`。位图与 ICO 均已提交，正常开发无需重做。

## 环境要求

- Node.js >= 22.12
- 部署需要 Deno CLI 与 Deno Deploy 账号

## 本地开发

```bash
npm ci
cp .env.example .env     # 可选：本地变量（.gitignore 已忽略）
npm run dev              # http://localhost:4321，自动加载 .env（若存在）
```

| 命令 | 说明 |
|------|------|
| `npm run dev` | Astro 开发服务器（默认 4321 端口），启动前加载 `.env` |
| `npm run build` | 构建 SSR 产物到 `dist/`，并生成 `dist/styles.css` |
| `npm run preview` | 预览构建产物 |
| `npm run icons` | 扫描源码图标类名，重新生成 `src/styles/icons.generated.css` |
| `npm run check` | `astro check` 类型与模板诊断 |
| `npm test` | 端到端测试（自动在 4399 端口起一个独立服务），同样加载 `.env` |
| `npm run deploy` | 构建并通过 `deno deploy` 发布 |

> 需要在代理后面出网时，把 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 和 `NODE_USE_ENV_PROXY=1` 写进 `.env`：Windows 的系统代理只对 curl 生效，Node 的 `fetch` 只认这几个环境变量，否则代理用例和 `npm test` 会以 `ECONNRESET` / 连接超时失败。

## 测试

```bash
npm test                                  # 公开模式
PROXY_PASSWORD=secret npm test            # 追加鉴权用例（401/403/主页放行/x-proxy-key/门禁凭据不透传上游）
GITHUB_TOKEN=<token> npm test             # 追加 api.github.com 认证配额用例（limit=5000）
TEST_URL=http://localhost:4321 npm test   # 复用已运行的服务，不再另起端口
```

测试通过真实 HTTP 请求校验：健康端点、统计端点、五个页面、GitHub 代理（raw + 仓库页）、Docker 代理（`/v2/` 与 `/api/ghcr/`、`/api/mcr/`）、Packages 代理（npm 元数据、goproxy 版本列表、sumdb 转发、jsDelivr 与 unpkg 资源、Maven 构件、PyPI 索引改写与 wheel 下载）、状态探测动态路由、未知前缀 404，以及可选的鉴权行为。用例依赖能访问 github.com / registry-1.docker.io / registry.npmjs.org / proxy.golang.org / cdn.jsdelivr.net / unpkg.com / repo1.maven.org / dl.google.com / pypi.org 的网络。

## 图标

图标在**构建期**烘焙成纯 CSS，运行时不请求任何图标 CDN。

1. 在 `.astro` / `.tsx` 中写类名：`class="icon-[material-symbols--settings]"`（`prefix--name` 即 Iconify 的 `prefix:name`）
2. 运行 `npm run icons` 生成 `src/styles/icons.generated.css`
3. 把生成文件一起提交（该文件参与构建，不能忽略）

```bash
better-icons search docker --limit 10   # 挑选图标（需 npm i -g better-icons）
better-icons get simple-icons:docker    # 查看 SVG
```

图标尺寸跟随字号：使用 `text-lg`、`text-[2rem]` 等 font-size 类，不要用 `size-*`。

## 环境变量

在 Deno Deploy 控制台或 CI Secret 中配置。本地开发把变量写入 `.env`（参考 `.env.example`），`npm run dev` 与 `npm test` 启动前会自动加载它。

| 变量 | 说明 | 默认 |
|------|------|------|
| `PROXY_PASSWORD` | 设置后所有代理路径要求鉴权：`Authorization: Basic proxy:<密码>` 或 `x-proxy-key: <密码>`；门禁凭据不会转发给上游，客户端仍可用 `authorization` 带自己的 git PAT / registry token | 不启用 |
| `DOCKER_HUB_USERNAME` / `DOCKER_HUB_PASSWORD` | Docker Hub 账号或 Access Token，用于换取拉取 token，缓解匿名限速 | 匿名 |
| `GITHUB_TOKEN` | 为 `api.github.com` 的只读请求补身份，绕开共享出口 IP 的匿名 60 次/时限制。只注入到 `/repos/{owner}/{repo}...` 与 `/rate_limit`，账号端点（`/user`、`/gists`、`/notifications`）与写请求一律不注入，注入身份的 scope 回显也不透出。**风险**：代理是公开的，必须用「未勾选任何 scope」的经典 token 或专用只读账号；带 `repo` scope 时知道私有仓库名的人可借代理读到它 | 不注入 |
| `SIZE_LIMIT` | 超过该大小（GB）的 Release 直接 302 回源 | `999` |
| `RATE_LIMIT` | 每 IP 每分钟代理请求上限，`0` 不限制 | `0` |
| `DEPLOY_ANALYTICS_TOKEN` | 用于 `/api/deno-analytics` 读取 Deno Deploy 用量（平台禁止 `DENO_` 前缀变量名，本地开发可回退 `DENO_API_TOKEN`）；不配置该端点返回 503 | 未配置 |
| `STATS_RETENTION_DAYS` | 按天存档的保留天数，超期的日桶会被清扫 | `180` |
| `STATS_FLUSH_REQUESTS` | 进程内缓冲多少条请求后落库 | `200` |
| `STATS_FLUSH_INTERVAL_MS` | 低流量时兜底落库间隔（毫秒） | `120000` |
| `STATS_SHARDS` | 计数器键分片数，写竞争激烈时调大摊薄 | `1` |

## 使用方式

将 `https://xxx.deno.dev` 替换为你的域名（首页与 `/github`、`/docker` 页面提供交互式 URL 转换器）。

### GitHub

| 原始地址 | 代理地址 |
|---------|---------|
| `https://github.com/owner/repo/releases/download/v1.0/app.zip` | `{域名}/api/gh/owner/repo/releases/download/v1.0/app.zip` |
| `https://raw.githubusercontent.com/owner/repo/main/README.md` | `{域名}/api/ghraw/owner/repo/main/README.md` |
| `https://github.com/owner/repo`（浏览页面） | `{域名}/api/gh/owner/repo` |
| `https://codeload.github.com/...` | `{域名}/api/codeload/...` |
| `https://objects.githubusercontent.com/...` | `{域名}/api/objects/...` |
| `https://api.github.com/...` | `{域名}/api/api.github.com/...` |
| `git clone https://github.com/owner/repo.git` | `git clone {域名}/api/gh/owner/repo.git` |

想让此后所有 `git clone` / `git fetch` 自动走加速（脚本写的是 `git config --global url.…insteadOf`，还原命令随脚本输出）：

```bash
curl -fsSL https://xxx.deno.dev/install/git.sh | sh
```

### Docker

镜像加速器方式（Docker Hub 生效，`/v2/` 为 registry 协议入口）：

```json
{
  "registry-mirrors": ["https://xxx.deno.dev"]
}
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart docker
```

Docker 只会向主机根路径发起 `/v2/...` 请求，因此 `docker pull` 支持两种方式：配置上面的 mirror，或直接给镜像加上 Docker Hub 命名空间：

```bash
docker pull xxx.deno.dev/library/nginx:latest   # 无需改 daemon.json
```

GHCR / GCR / K8s / Quay / MCR 的前缀位于子路径下，供 HTTP 直接取 manifest 与 blob（curl、脚本，或支持带路径 registry 的工具）：

```bash
curl https://xxx.deno.dev/api/ghcr/v2/<owner>/<image>/manifests/<tag> \
  -H "Authorization: Bearer <token>"
```

### npm

Registry 指向 `/api/npm/`（透传 npm 官方源 registry.npmjs.org）：

```bash
# 一键脚本（POSIX shell，已安装的 pnpm / yarn 一并设置）
curl -fsSL https://xxx.deno.dev/install/npm.sh | sh

# 或手动
npm config set registry https://xxx.deno.dev/api/npm/
# pnpm / yarn 同理；项目内也可写 .npmrc: registry=https://xxx.deno.dev/api/npm/
```

### Go Modules

```bash
# 一键脚本
curl -fsSL https://xxx.deno.dev/install/go.sh | sh

# 或手动
go env -w GOPROXY=https://xxx.deno.dev/api/goproxy/,direct
```

Go 1.15+ 会把校验和数据库查询发到 `{GOPROXY}/sumdb/sum.golang.org/...`，本代理已将其转发到 sum.golang.org，GOPRIVATE 之外的模块验证无需额外配置。

### jsDelivr

把 `cdn.jsdelivr.net` 替换为 `{域名}/api/jsd` 即可，路径不变：

```
https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js
→ https://xxx.deno.dev/api/jsd/npm/vue@3/dist/vue.global.prod.js
```

### unpkg

把 `unpkg.com` 替换为 `{域名}/api/unpkg` 即可，路径不变：

```
https://unpkg.com/vue@3/dist/vue.global.prod.js
→ https://xxx.deno.dev/api/unpkg/vue@3/dist/vue.global.prod.js
```

未指定版本的链接会由 unpkg 返回 302 到具体版本，`Location` 同样被改写回本代理，解析后继续走加速通道。

### Maven

构件按路径直接透传，把仓库地址加上 `{域名}/api` 前缀即可（`/api/maven/` → Maven Central，`/api/gmaven/` → Google Maven）：

```groovy
// settings.gradle / build.gradle
repositories {
    maven { url 'https://xxx.deno.dev/api/maven/maven2' }
    maven { url 'https://xxx.deno.dev/api/gmaven/android/maven2' }
}
```

```xml
<!-- ~/.m2/settings.xml -->
<mirror>
  <id>proxy-central</id>
  <mirrorOf>central</mirrorOf>
  <url>https://xxx.deno.dev/api/maven/maven2</url>
</mirror>
```

### PyPI

索引指向 `/api/pypi/simple/`（透传官方源 pypi.org）：

```bash
# 一键脚本（写入 pip 全局配置，pip 23.1+ 才支持 config 子命令）
curl -fsSL https://xxx.deno.dev/install/pypi.sh | sh

# 或手动
pip config set global.index-url https://xxx.deno.dev/api/pypi/simple/
# 或单次安装 / CI 环境变量
pip install -i https://xxx.deno.dev/api/pypi/simple/ requests
export PIP_INDEX_URL=https://xxx.deno.dev/api/pypi/simple/   # uv 同样读取
```

simple 索引（HTML 与 JSON）与包 JSON 中内嵌的 `files.pythonhosted.org` 绝对下载地址会被改写为 `{域名}/api/pyf/...`，wheel 与 sdist 因此同样走加速通道；URL 上的 `#sha256=` 片段不变，pip 的完整性校验照常生效。

## 路径前缀

| 前缀 | 上游 |
|------|------|
| `/api/gh/` | github.com |
| `/api/ghraw/` | raw.githubusercontent.com |
| `/api/codeload/` | codeload.github.com |
| `/api/objects/` | objects.githubusercontent.com |
| `/api/release-assets/` | release-assets.githubusercontent.com |
| `/api/api.github.com/` | api.github.com |
| `/api/avatars/` | avatars.githubusercontent.com |
| `/v2/` | registry-1.docker.io |
| `/api/ghcr/` | ghcr.io |
| `/api/gcr/` | gcr.io |
| `/api/k8s/` | registry.k8s.io |
| `/api/quay/` | quay.io |
| `/api/mcr/` | mcr.microsoft.com |
| `/api/npm/` | registry.npmjs.org（JSON 元数据中的绝对 URL 重写回本代理） |
| `/api/goproxy/` | proxy.golang.org |
| `/api/goproxy/sumdb/sum.golang.org/` | sum.golang.org（Go 校验库转发） |
| `/api/jsd/` | cdn.jsdelivr.net |
| `/api/unpkg/` | unpkg.com（版本解析的同源 302 会改写回本代理） |
| `/api/maven/` | repo1.maven.org（Maven Central） |
| `/api/gmaven/` | dl.google.com（Google Maven / Android） |
| `/api/pypi/` | pypi.org（simple 索引与包 JSON 内的下载地址重写回本代理） |
| `/api/pyf/` | files.pythonhosted.org（wheel / sdist 下载） |

## 站点端点

| 端点 | 说明 |
|------|------|
| `/`、`/github`、`/docker`、`/packages`、`/status` | 说明页与状态看板 |
| `/api/health` | 存活检查、版本、统计后端与限流状态 |
| `/api/stats` | 今日与累计统计（按上游注册表的服务维度拆分，如 github / docker / npm / go / jsd / maven / mcr / 站点；每服务含 requests 原始请求数与 uses 使用次数） |
| `/api/stats/history?days=30` | 按天存档回看，保留期内可查，超出 `STATS_RETENTION_DAYS` 自动裁剪 |
| `/api/status` | 全部上游连通性探测，一次返回（状态页用它，逐个服务取要 9 个请求） |
| `/api/status/{github,docker,npm,go,jsd,unpkg,maven,mcr,pypi}` | 单个上游探测，留给外部监控（结果按实例缓存 `PROBE_TTL_MS`） |
| `/api/deno-analytics` | Deno Deploy 用量（需 `DEPLOY_ANALYTICS_TOKEN`，按实例缓存 5 分钟） |
| `/install/{npm,pypi,go,git}.sh` | 一键配置脚本，按请求域名生成 POSIX shell，`curl -fsSL … \| sh` 直接用；Docker 与 Maven 要改系统级配置文件，不提供脚本 |

探测与平台用量端点都接受 `?force=1`：跳过服务端缓存立刻回源，状态页的「刷新」按钮用它。

## 项目结构

```
├── src/
│   ├── middleware.ts            # Astro 中间件：代理鉴权 + 访问/流量统计
│   ├── layouts/Layout.astro     # 品牌元信息（OG/canonical/theme-color）、导航、主题切换、FOUC 防护
│   ├── pages/
│   │   ├── index|github|docker|packages|status.astro
│   │   ├── 404.astro            # 站内 404（代理前缀未命中返回 JSON，不走本页）
│   │   ├── api/[...path].ts     # /api/* 代理入口（前缀 -> 上游）
│   │   ├── api/{health,stats,deno-analytics,...}.ts
│   │   ├── api/stats/history.ts # 按天存档回看
│   │   ├── api/status/*.ts      # 上游连通性探测
│   │   ├── install/[tool].sh.ts # 一键配置脚本（npm / pypi / go / git）
│   │   └── v2/[...path].ts      # Docker registry 协议入口
│   ├── components/
│   │   ├── BrandMark.astro      # 品牌标识（currentColor 单色，任意尺寸可用）
│   │   └── UrlConverter.astro
│   ├── lib/
│   │   ├── brand.ts             # 品牌名/主张/主题色（文案单一来源）
│   │   ├── services.ts          # 上游注册表：前缀 -> 上游 -> 服务标签（路由/鉴权/统计/重定向的唯一来源）
│   │   ├── proxy.ts             # GitHub/Docker 代理核心
│   │   ├── config.ts            # 环境变量
│   │   ├── stats.ts             # 统计：进程内缓冲 + KV sum 原子自增（内存后端兜底）
│   │   ├── platform-usage.ts    # 平台用量按 UTC 日归档（整日覆盖写，只在数值增长时落库）
│   │   ├── rate-limit.ts        # 每 IP 限流
│   │   ├── probe.ts             # 上游探测 + 单实例结果缓存（状态页/平台用量）
│   │   ├── logging.ts           # 结构化请求日志
│   │   └── helpers.ts           # 鉴权、头过滤、响应字节计数
│   └── styles/
│       ├── global.css           # 主题令牌 + 毛玻璃样式
│       └── icons.generated.css  # 自动生成，勿手改
├── public/
│   ├── favicon.svg              # 品牌图标源文件（渐变底板 + 白色标识）
│   ├── favicon.ico              # 16/32 两档 PNG-in-ICO 容器
│   ├── apple-touch-icon.png     # 180
│   ├── icons/icon-{192,512}.png # PWA 图标（含 maskable）
│   ├── og-image.{svg,jpg}       # 分享卡片：svg 为源，jpg 为实际引用
│   ├── manifest.webmanifest
│   └── robots.txt
├── scripts/build-icons.mjs      # 图标 CSS 生成
├── tests/e2e.test.ts            # Node 端到端测试
├── astro.config.mjs             # output: server + @deno/astro-adapter
└── .github/workflows/deploy.yml # CI：构建/图标校验/测试，main 分支部署
```

## 部署

推送到 `main` 会触发 CI 构建与测试；配置仓库 Secret `DENO_DEPLOY_TOKEN` 后，`deploy` 作业会自动发布到 Deno Deploy。

手动部署：

```bash
npm ci
npm run build
npm run deploy    # 需要本地已安装 Deno CLI 并配置 DENO_DEPLOY_TOKEN
```

## 已知限制

- 流量按实际写出字节统计（在响应流上逐块累加）；客户端中断时上游 `fetch` 随请求的 abort 信号一起取消，因此不再继续搬运没有送达的字节
- 计数先入进程缓冲区，满 200 次请求或 2 分钟才落库，因此看板数字有同量级延迟；`/api/stats` 读取前会先 flush 本实例增量
- 存档只到自然日（不细到小时）：日桶按 `STATS_RETENTION_DAYS` 滚动清理，累计桶永久保留，清理每份保留期只做一次且跨实例共享标记
- 请求数不等于「拉取次数」：一次 `docker pull` 会拆成多个 `/v2/` 请求，一次 `git clone` 也可能是多个请求；表格中的「使用次数」已按取用动作收敛，但多架构镜像的一次 pull 会取 manifest list 与平台 manifest 各一次，仍会计 2
- 访客按「IP + User-Agent 当日去重」估算，运营商级 NAT 与 CI 场景下仅供参考
- 限流是**单实例内存**状态，边缘多实例下为尽力而为
- **Release 下载无法强缓存**：GitHub 的资产地址每次换签名参数（`sig`/`jwt`/`skt`/`ske`），代理改写完 `Location` 后的第二跳 URL 每个请求都不同，任何按 URI 取键的缓存都只会 miss。因此本站不再为 Release 声明 `immutable` 头（原 `CACHE_RELEASE` 开关只作用在永远拿不到正文的第一跳，已删）
- 状态页数据在浏览器本地缓存（探测与访问统计 60 秒、平台统计 5 分钟），刷新页面不重新请求；需要立刻回源用「刷新」按钮，两块区域各自一个（服务节点列表的按钮在页面标题右侧，只重取探测与表内统计；访问统计的按钮在卡片标题右侧，只重取主站与平台用量），互不影响。后台标签页停止轮询（一个挂着不看的页面就是持续的同源请求流量），切回前台立刻补一轮
- 上游探测结果与平台用量另有**单实例服务端缓存**（分别 30 秒、5 分钟），同实例多访客共享一次出网探测；边缘多实例下各自缓存，状态最坏滞后一个 TTL
- 状态页的「平台用量-累计」来自本站按 UTC 日写入 KV 的归档（`lib/platform-usage.ts`）：Deno 分析接口不承诺可查窗口，只保证最近这段，所以累计值随部署时长增长，刚上线时会小于平台控制台口径
- **带凭据的响应不进公共缓存**：请求带客户端自己的上游凭据（`authorization`，不是门禁密码）或身份由代理代填（`GITHUB_TOKEN`）时，响应一律改写为 `cache-control: private, no-store`。CDN 的缓存键不含 `authorization`，且默认忽略 `Vary`，一旦把这类响应按裸 URL 存下来，就会喂给后续的匿名请求。全站门禁（`x-proxy-key` 或 `Basic proxy:<密码>`）不构成私有：用它取回的内容对所有已授权访客都一样，仍然可缓存
- 本站只声明缓存头，不额外前置 CDN。以 Cloudflare 为例：它默认忽略 `Vary`、缓存键只有 host+path（按请求头定制缓存键是 Enterprise 特性），而它的服务条款把「用 CDN 分发不属于自己的大文件」列为可以限速/关停的行为（Free/Pro/Business 都受限，只有 Enterprise 或把内容放进 R2/Images/Stream 才豁免）—— 一个第三方内容镜像挂到它前面，省下的配额和账号风险是同一个杠杆
- `PROXY_PASSWORD` 只保护代理路径，页面与 `/api/health`、`/api/stats` 始终公开
- 不支持 WebSocket

MIT
