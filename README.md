# Docker Proxy - Cloudflare Snippets Edition

这是一个专为 **Cloudflare Snippets** (Rules -> Snippets) 设计的极简版 Docker 镜像仓库加速代理脚本。

与传统 Worker 版本相比，此版本移除了繁重的响应体正则替换操作，将代码压缩到了几十行，完美符合 Snippets 严苛的 **5ms CPU 耗时限制**，并且可以直接绑定在你现有的域名上运行。

## ✨ 特性

- **多仓库支持**：原生支持代理 `Docker Hub`、`ghcr.io` (GitHub)、`gcr.io` (Google)、`quay.io` 等常见的第三方镜像库。
- **极简高性能**：专为 Snippets 引擎优化，无正则 body 替换，确保不超时。
- **动态 Auth 鉴权劫持**：兼容多个仓库的不同 Token 服务器，自动拦截 401 鉴权挑战。
- **官方镜像补全**：自动为 `nginx` 等短名官方 Docker 镜像补足 `/v2/library/` 路径。

## 🚀 部署指南 (Cloudflare Snippets)

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，进入你的**域名管理**面板。
2. 在左侧菜单栏找到 **Rules** (规则) -> **Snippets** (片段)。
3. 点击 **Create Snippet**，给它取个名字（如 `docker-proxy`）。
4. 将本项目中 `index.js` 的代码全部复制并粘贴到代码框中。
5. 在 **Filter** (过滤器) 中配置该规则的触发条件。例如：
   - 匹配 Hostname 等于 `docker.你的域名.com` 
   - （请确保你已经在 DNS 里将 `docker.你的域名.com` 代理状态开启，即点亮黄色的云朵）
6. 点击 **Save and Deploy** (保存并部署)。

## 💻 客户端使用指南

### 1. 拉取常规 Docker Hub 镜像
通过修改 daemon 配置，实现无缝拉取：

编辑 `/etc/docker/daemon.json`：
```json
{
  "registry-mirrors": [
    "https://docker.你的域名.com"
  ]
}
```
重启 Docker 服务：
```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
```
测试拉取：
```bash
docker pull alpine
```

### 2. 拉取第三方镜像 (如 ghcr.io, gcr.io)
> ⚠️ **注意**：Docker 的 `registry-mirrors` 机制天生**只对 Docker Hub 生效**。对于其它第三方仓库，你必须手动在镜像名称前面加上你的代理域名！

**原命令：**
`docker pull ghcr.io/wg-easy/wg-easy:15.4.0`

**加速拉取命令：**
`docker pull docker.你的域名.com/ghcr.io/wg-easy/wg-easy:15.4.0`

脚本会自动识别路径中的 `ghcr.io`，剥离多余路径，并去正确的服务器拉取资源及鉴权 Token！
