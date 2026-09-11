export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const originHost = url.hostname;

    // 默认上游
    let upstreamHost = "registry-1.docker.io";

    // 1. 判断是否包含常见的第三方仓库前缀
    // 例如：docker pull 你的域名/ghcr.io/wg-easy/wg-easy:15.4.0
    // 实际请求的 Path 为: /v2/ghcr.io/wg-easy/wg-easy/manifests/15.4.0
    const thirdPartyRegistries = ["ghcr.io", "gcr.io", "k8s.gcr.io", "registry.k8s.io", "quay.io"];
    for (const registry of thirdPartyRegistries) {
      if (path.includes(`/${registry}/`)) {
        upstreamHost = registry;
        // 把前缀从路径中抹除掉，让上游仓库能正确识别
        // 例如 /v2/ghcr.io/wg-easy -> /v2/wg-easy
        url.pathname = path.replace(`/${registry}/`, "/");
        break;
      }
    }

    // 2. 路由与上游域名分配 (处理 Docker Hub 专有路由)
    if (path.startsWith("/token") || path.startsWith("/auth/")) {
      // 如果请求携带了自定参数来指定第三方 Auth (进阶处理，通常用作备用)
      const targetAuth = url.searchParams.get("auth_host") || "auth.docker.io";
      url.hostname = targetAuth;
      url.pathname = url.pathname.replace(/^\/auth/, "");
    } else if (path.startsWith("/search") || path.startsWith("/v1/")) {
      url.hostname = "index.docker.io";
    } else {
      url.hostname = upstreamHost;
      // 补全 Docker Hub 的 library 前缀 (只针对 Docker Hub，且不包含第三方的场景)
      if (upstreamHost === "registry-1.docker.io" && url.pathname.startsWith("/v2/") && url.pathname.split("/").length === 5) {
        url.pathname = url.pathname.replace("/v2/", "/v2/library/");
      }
    }

    // 3. 发起透传请求
    const response = await fetch(new Request(url, {
      method: request.method,
      headers: request.headers,
      redirect: "follow"
    }));

    // 4. 劫持鉴权服务器地址 (支持多仓库)
    const resHeaders = new Headers(response.headers);
    const authHeader = resHeaders.get("www-authenticate");
    
    if (authHeader && response.status === 401) {
      // 正则匹配出 realm 网址 (例如 https://ghcr.io/token 或 https://auth.docker.io/token)
      const match = authHeader.match(/realm="([^"]+)"/);
      if (match && match[1]) {
        const originAuthUrl = match[1];
        try {
          const authHost = new URL(originAuthUrl).hostname;
          // 重写 realm 到我们的代理服务器，并通过 auth_host 参数告知代理这是去哪个仓库的认证
          const proxyAuthUrl = `https://${originHost}/token?auth_host=${authHost}`;
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
