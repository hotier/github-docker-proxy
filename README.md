# GitHub & Docker Proxy on Deno Deploy

基于 [Deno Deploy](https://deno.com/deploy) 的免费边缘代理，加速 GitHub 和 Docker 资源访问。

## 特性

- ✅ GitHub Release/Raw/Archive/git-clone 加速
- ✅ Docker Hub/GHCR/GCR/K8s/Quay 镜像加速
- ✅ 流式大文件传输（无大小限制）
- ✅ Basic Auth 鉴权（可选）
- ✅ 自动处理 Docker Hub Token
- ✅ 免费额度：100万请求/天

## 快速部署

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
deployctl deploy --project=your-project-name main.ts
```

### 方式三：使用你的项目 ID 部署

如果你已经有项目 ID（如 `ddp_IdNnvTdsWOQHjL8xTXmTqKV12dapS4cgvpae`）：

```bash
# 设置环境变量
export DENO_DEPLOY_TOKEN=ddp_IdNnvTdsWOQHjL8xTXmTqKV12dapS4cgvpae

# 直接部署到指定项目
deployctl deploy --project=your-project-name --token=$DENO_DEPLOY_TOKEN main.ts
```

## 环境变量配置

在 Deno Deploy Dashboard → Settings → Environment Variables 中添加：

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `PROXY_PASSWORD` | 访问密码（设置后需要 Basic Auth） | 否 |
| `DOCKER_HUB_USERNAME` | Docker Hub 账号（提升限速） | 否 |
| `DOCKER_HUB_PASSWORD` | Docker Hub 密码或 Access Token | 否 |

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
| `/v2/` | registry-1.docker.io (Docker Hub) |
| `/ghcr/` | ghcr.io |
| `/gcr/` | gcr.io |
| `/k8s/` | registry.k8s.io |
| `/quay/` | quay.io |

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

### 测试 GitHub 代理
```bash
curl -I https://xxx.deno.dev/gh/octocat/Hello-World
```

### 测试 Docker 代理
```bash
curl -I https://xxx.deno.dev/v2/
# 应返回 401（需要 token）或 200
```

## 许可证

MIT
