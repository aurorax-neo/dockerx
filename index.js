export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const originHost = url.hostname;

    // 默认上游
    let upstreamHost = "registry-1.docker.io";

    // 常见第三方镜像仓库映射与鉴权路由配置
    const REGISTRY_CONFIG = {
      "docker.io": { upstream: "registry-1.docker.io", authHost: "auth.docker.io", authPath: "/token", service: "registry.docker.io" },
      "registry-1.docker.io": { authHost: "auth.docker.io", authPath: "/token", service: "registry.docker.io" },
      "ghcr.io": { authHost: "ghcr.io", authPath: "/token", service: "ghcr.io" },
      "quay.io": { authHost: "quay.io", authPath: "/v2/auth", service: "quay.io" },
      "gcr.io": { authHost: "gcr.io", authPath: "/v2/token", service: "gcr.io" },
      "k8s.gcr.io": { upstream: "registry.k8s.io", authHost: "registry.k8s.io", authPath: "/token", service: "registry.k8s.io" },
      "registry.k8s.io": { authHost: "registry.k8s.io", authPath: "/token", service: "registry.k8s.io" },
      "mcr.microsoft.com": { authHost: null, authPath: null, service: null },
      "nvcr.io": { authHost: "nvcr.io", authPath: "/proxy_auth", service: "registry" },
      "docker.elastic.co": { authHost: "docker-auth.elastic.co", authPath: "/auth", service: "token-service" },
      "registry.gitlab.com": { authHost: "gitlab.com", authPath: "/jwt/auth", service: "container_registry" },
      "public.ecr.aws": { authHost: "public.ecr.aws", authPath: "/token/", service: "public.ecr.aws" }
    };

    // 拦截非 Docker 规范的未知探测请求 (防扫描)
    const isValidDockerReq = path === "/v2" || path.startsWith("/v2/") || path.startsWith("/v1/") || path.startsWith("/search") || path.startsWith("/token") || path.startsWith("/auth/");
    if (!isValidDockerReq) {
      // 隐蔽模式：返回空 404 阻断未知探测请求，不暴露代理特征
      return new Response(null, { status: 404 });
    }

    // 1. 判断是否包含第三方仓库前缀: /v2/<domain>/...
    // 例如：docker pull 你的域名/ghcr.io/linuxserver/docker-nginx:latest
    const thirdPartyMatch = path.match(/^\/v2\/([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\/(.*)$/);
    if (thirdPartyMatch) {
      const reg = thirdPartyMatch[1];
      const cfg = REGISTRY_CONFIG[reg];
      upstreamHost = (cfg && cfg.upstream) ? cfg.upstream : reg;
      // 抹除域名前缀，让上游仓库正确识别路径
      url.pathname = `/v2/${thirdPartyMatch[2]}`;
    }

    // 2. 路由与上游域名分配 (处理鉴权路由与多仓库分发)
    if (path.startsWith("/token") || path.startsWith("/auth/")) {
      const tokenPathMatch = path.match(/^\/(?:token|auth)\/([^\/]+)(\/.*)?$/);
      let targetAuth = tokenPathMatch ? tokenPathMatch[1] : null;
      let targetPath = tokenPathMatch ? (tokenPathMatch[2] || "/token") : null;

      // 兜底：从 query 参数中提取
      if (!targetAuth) targetAuth = url.searchParams.get("auth_host");
      if (!targetPath && url.searchParams.get("auth_path")) targetPath = decodeURIComponent(url.searchParams.get("auth_path"));

      const service = url.searchParams.get("service") || "";
      const scope = url.searchParams.get("scope") || "";

      // 智能识别第三方仓库 (优先从 scope 的域名前缀匹配，其次从 targetAuth)
      let matchedRegistry = null;
      if (scope) {
        const scopeMatch = scope.match(/(?:^|\s)repository:([a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\/(.+)$/);
        if (scopeMatch) matchedRegistry = scopeMatch[1];
      }
      if (!matchedRegistry && targetAuth && targetAuth !== "auth.docker.io") {
        matchedRegistry = targetAuth;
      }

      if (matchedRegistry) {
        const cfg = REGISTRY_CONFIG[matchedRegistry] || {};
        targetAuth = cfg.authHost || matchedRegistry;
        targetPath = cfg.authPath || "/token";
        url.searchParams.set("service", cfg.service || matchedRegistry);
        // 去除 scope 中的 registry 前缀
        const newScope = scope.replace(`repository:${matchedRegistry}/`, "repository:").replace(`${matchedRegistry}/`, "");
        url.searchParams.set("scope", newScope);
      } else {
        // 默认为 Docker Hub
        targetAuth = targetAuth || "auth.docker.io";
        targetPath = targetPath || "/token";
        // 补全 Docker Hub 官方镜像在获取 Token 时缺失的 library/ 前缀
        if (scope && scope.includes("repository:")) {
          const newScope = scope.split(" ").map(s => s.replace(/^repository:([^/:]+):/, "repository:library/$1:")).join(" ");
          url.searchParams.set("scope", newScope);
        }
      }

      url.hostname = targetAuth;
      url.pathname = targetPath;
      url.searchParams.delete("auth_host");
      url.searchParams.delete("auth_path");
    } else if (path.startsWith("/search") || path.startsWith("/v1/")) {
      url.hostname = "index.docker.io";
    } else {
      url.hostname = upstreamHost;
      // 补全 Docker Hub 官方短名镜像 library/ 前缀 (精确匹配 manifests/blobs/tags/referrers)
      if (upstreamHost === "registry-1.docker.io") {
        url.pathname = url.pathname.replace(/^\/v2\/([^\/]+)\/(manifests|blobs|tags|referrers)(\/.*)?$/, "/v2/library/$1/$2$3");
      }
    }

    // 3. 构造透传请求
    const init = {
      method: request.method,
      headers: new Headers(request.headers),
      redirect: "follow"
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    init.headers.delete('Host');
    init.headers.delete('X-Forwarded-For');
    init.headers.delete('X-Real-IP');
    init.headers.delete('CF-Connecting-IP');
    init.headers.delete('Referer');

    // [解决 429 限制的终极方案]
    // 填入你 Docker Hub 的用户名和密码的 Base64 编码 (终端运行 `echo -n 'username:password' | base64` 获取)
    // 强制使用你的账号身份去获取 Token，突破 CF IP 被滥用导致的匿名限流！
    const DOCKER_AUTH_B64 = ""; // 例如 "dXNlcjpwYXNz"
    
    // 强制使用配置的 Docker Hub 账号凭据，彻底杜绝客户端残留登录态导致的鉴权错误
    if (DOCKER_AUTH_B64 && url.hostname === "auth.docker.io") {
      init.headers.set("Authorization", `Basic ${DOCKER_AUTH_B64}`);
    }

    // 发起请求
    const response = await fetch(url.href, init);

    // 4. 劫持鉴权服务器地址 (支持多仓库)
    const resHeaders = new Headers(response.headers);
    const authHeader = resHeaders.get("www-authenticate");
    
    if (authHeader && response.status === 401) {
      // 正则匹配出 realm 网址 (例如 https://ghcr.io/token 或 https://auth.docker.io/token)
      const match = authHeader.match(/realm="([^"]+)"/);
      if (match && match[1]) {
        const originAuthUrl = match[1];
        try {
          const authUrlObj = new URL(originAuthUrl);
          // 将 upstream 的 host 和 path 编码进代理路径中 (例如 /token/ghcr.io/token)
          // 避免客户端在向 realm 发起请求追加 service/scope query 时抹除原有 query 参数
          const authPath = authUrlObj.pathname && authUrlObj.pathname !== "/" ? authUrlObj.pathname : "/token";
          const proxyAuthUrl = `https://${originHost}/token/${authUrlObj.hostname}${authPath}`;
          resHeaders.set("www-authenticate", authHeader.replace(originAuthUrl, proxyAuthUrl));
        } catch (e) {
          // URL 解析失败时原样返回
        }
      }
    }

    return new Response(response.body, {
      status: response.status,
      headers: resHeaders
    });
  }
};
