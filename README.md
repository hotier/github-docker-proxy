# GitHub & Docker Proxy on Deno Deploy

基于 [Deno Deploy](https://deno.com/deploy) 的免费边缘代理，加速 GitHub 和 Docker 资源访问。

## 特性

- ✅ GitHub Release/Raw/Archive/git-clone 加速
- ✅ Docker Hub/GHCR/GCR/K8s/Quay 镜像加速
- ✅ 流式大文件传输（无大小限制）
- ✅ Basic Auth 鉴权（可选）
- ✅ 自动处理 Docker Hub Token
- ✅ 免费额度：100万请求/天
- ✅ 现代化暗色主题首页
- ✅ 交互式 URL 转换器

## 快速开始

### 本地开发

```bash
# 克隆项目
git clone https://github.com/hotier/github-docker-proxy.git
cd github-docker-proxy

# 运行开发服务器（默认端口 8000）
deno task dev

# 或带热重载
deno task dev:watch

# 自定义端口
PORT=3000 deno task dev
```

访问 http://localhost:8000 查看首页。

### 运行测试

```bash
# 运行所有测试（需要服务器在后台运行）
deno task test

# 或先启动服务器，再运行测试
deno task dev &
deno task test
```

### 代码检查

```bash
# TypeScript 类型检查
deno task check

# 代码格式化
deno task fmt

# Lint 检查
deno task lint
```

## 部署到 Deno Deploy

### 方式一：GitHub 自动部署（推荐）

1. Fork 本项目到你的 GitHub
2. 登录 [Deno Deploy](https://dash.deno.com/)
3. 点击 **New Project** → **Deploy from GitHub**
4. 选择你的仓库，入口文件填 `main.ts`
5. 点击 **Deploy**，自动获得 `https://xxx.deno.dev` 域名

### 方式二：CLI 部署

```bash
# 安装 Deno
curl -fsSL https://deno.land/install.sh | sh

# 安装 deployctl
deno install --allow-all --no-check -r -f https://deno.land/x/deploy/deployctl.ts

# 登录（浏览器授权）
deployctl login

# 部署
deployoctl deploy --project=your-project-name main.ts
```

## 环境变量配置

在 Deno Deploy Dashboard → Settings → Environment Variables 中添加：

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `PROXY_PASSWORD` | 访问密码（设置后需要 Basic Auth） | 否 |
| `DOCKER_HUB_USERNAME` | Docker Hub 账号（提升限速） | 否 |
| `DOCKER_HUB_PASSWORD` | Docker Hub 密码或 Access Token | 否 |

本地开发时，复制 `.env.example` 为 `.env` 并填写。

## 使用方式

### GitHub 加速

| 原始 URL | 代理 URL |
|---------|---------|
| `https://github.com/owner/repo/releases/download/...` | `https://xxx.deno.dev/gh/owner/repo/releases/download/...` |
| `https://raw.githubusercontent.com/owner/repo/branch/file` | `https://xxx.deno.dev/ghraw/owner/repo/branch/file` |
| `https://github.com/owner/repo.git` (git clone) | `https://xxx.deno.dev/gh/owner/repo.git` |

### Docker 加速

配置 Docker daemon (`/etc/docker/daemon.json`)：

```json
{
  "registry-mirrors": ["https://xxx.deno.dev"]
}
```

重启 Docker：
```bash
sudo systemctl restart docker
```

或者直接指定镜像地址：

```bash
# Docker Hub
docker pull xxx.deno.dev/library/nginx:latest

# GHCR
docker pull xxx.deno.dev/ghcr.io/owner/image:tag

# GCR
docker pull xxx.deno.dev/gcr.io/project/image:tag
```

## 路径前缀速查

| 前缀 | 上游 |
|------|------|
| `/gh/` | github.com |
| `/ghraw/` | raw.githubusercontent.com |
| `/codeload/` | codeload.github.com |
| `/objects/` | objects.githubusercontent.com |
| `/release-assets/` | release-assets.githubusercontent.com |
| `/api.github.com/` | api.github.com |
| `/v2/` | registry-1.docker.io (Docker Hub) |
| `/ghcr/` | ghcr.io |
| `/gcr/` | gcr.io |
| `/k8s/` | registry.k8s.io |
| `/quay/` | quay.io |

## 项目结构

```
github-docker-proxy/
├── main.ts              # 主入口（包含所有逻辑）
├── deno.json            # Deno 配置和任务
├── tests/
│   └── main_test.ts     # 测试文件
├── .vscode/             # VS Code 配置
│   ├── launch.json      # 调试配置
│   ├── settings.json    # Deno 设置
│   └── extensions.json  # 推荐扩展
├── .env.example         # 环境变量示例
├── .gitignore           # Git 忽略
└── README.md            # 本文档
```

## 开发工作流

```bash
# 1. 启动开发服务器（热重载）
deno task dev:watch

# 2. 在另一个终端运行测试
deno task test

# 3. 提交前检查
deno task check
deno task fmt
deno task lint

# 4. 提交并推送（自动部署到 Deno Deploy）
git add .
git commit -m "feat: your feature"
git push
```

## 注意事项

1. **额度**：免费版 100万请求/天，个人使用足够
2. **大文件**：支持流式传输，但 Deno Deploy 有 128MB 内存限制（流式不受影响）
3. **WebSocket**：不支持
4. **鉴权**：如果设置 `PROXY_PASSWORD`，所有请求需要 Basic Auth

## 故障排查

### 检查服务状态
```bash
curl https://xxx.deno.dev/health
```

### 诊断外部连接
```bash
curl https://xxx.deno.dev/diag
```

### 测试 GitHub 代理
```bash
curl -I https://xxx.deno.dev/gh/octocat/Hello-World
```

### 测试 Docker 代理
```bash
curl -I https://xxx.deno.dev/v2/
# 应返回 401（需要 token）或 200
```

## 技术栈

- **运行时**: Deno
- **部署**: Deno Deploy（边缘网络）
- **语言**: TypeScript
- **测试**: Deno Test
- **代码风格**: Deno Lint + Deno Fmt

## 许可证

MIT
