// 端到端测试:对运行中的站点做真实 HTTP 校验
// 默认自动在 4399 端口启动一个独立 dev server;设置 TEST_URL 则复用已有服务
// 鉴权用例:设置 PROXY_PASSWORD 后运行,未设置时自动跳过

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

const PORT = 4399;
const BASE_URL = process.env.TEST_URL ?? `http://localhost:${PORT}`;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD ?? '';

let server: ReturnType<typeof spawn> | null = null;

async function isHealthy(url = `${BASE_URL}/api/health`): Promise<boolean> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Server at ${BASE_URL} did not become healthy in time`);
}

function authHeaders(): Record<string, string> {
  if (!PROXY_PASSWORD) return {};
  const token = Buffer.from(`proxy:${PROXY_PASSWORD}`).toString('base64');
  return { authorization: `Basic ${token}` };
}

// 用例自己要占用 authorization 转发上游凭据时，门禁改走 x-proxy-key
function gateHeaders(): Record<string, string> {
  return PROXY_PASSWORD ? { 'x-proxy-key': PROXY_PASSWORD } : {};
}

before(async () => {
  if (process.env.TEST_URL) {
    await waitForServer();
    return;
  }
  // 端口被占用时可能连到环境变量不同的旧实例,先要求空闲
  if (await isHealthy()) {
    throw new Error(
      `${BASE_URL} 已有服务在运行。请先执行 npx astro dev stop,或设置 TEST_URL 复用该服务。`
    );
  }
  // 直接运行 astro 入口,便于 after() 精确终止该进程(经 npx 会残留子进程)
  // --ignore-lock:不抢占项目的 dev 锁,避免杀掉开发者正在跑的 4321 服务
  server = spawn(
    process.execPath,
    ['node_modules/astro/bin/astro.mjs', 'dev', '--port', String(PORT), '--ignore-lock'],
    { stdio: 'ignore', env: process.env }
  );
  await waitForServer();
});

after(() => {
  server?.kill();
});

describe('健康与观测端点', () => {
  it('/api/health 返回 ok', async () => {
    const resp = await fetch(`${BASE_URL}/api/health`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.status, 'ok');
    assert.ok(typeof data.timestamp === 'number');
  });

  it('/api/stats 返回按服务拆分的今日与累计统计', async () => {
    const resp = await fetch(`${BASE_URL}/api/stats`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.ok(data.today);
    assert.ok(data.total);
    assert.equal(typeof data.today.pageViews, 'number');
    assert.equal(typeof data.today.github.requests, 'number');
    assert.equal(typeof data.today.github.uses, 'number');
    assert.equal(typeof data.today.github.bytes, 'number');
    assert.equal(typeof data.today.docker.requests, 'number');
    assert.equal(typeof data.today.npm.requests, 'number');
    assert.equal(typeof data.today.go.requests, 'number');
    assert.equal(typeof data.today.jsd.requests, 'number');
  });

  it('/api/stats/history 返回按天存档序列并按保留期裁剪', async () => {
    const resp = await fetch(`${BASE_URL}/api/stats/history?days=7`);
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.requestedDays, 7);
    assert.equal(typeof data.retentionDays, 'number');
    assert.match(data.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(data.to, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(data.series));
    assert.ok(data.series.length >= 1, '至少含今日');

    const last = data.series[data.series.length - 1];
    assert.equal(last.date, data.to, '序列要按日期升序且含今日');
    for (const day of data.series) {
      assert.equal(typeof day.github.requests, 'number');
      assert.equal(typeof day.github.bytes, 'number');
      assert.equal(typeof day.docker.requests, 'number');
      assert.equal(typeof day.pageViews, 'number');
      assert.ok(day.github.requests >= 0 && day.github.bytes >= 0);
    }

    const over = await (await fetch(`${BASE_URL}/api/stats/history?days=99999`)).json();
    assert.ok(
      over.to >= over.from &&
        new Date(over.to).getTime() - new Date(over.from).getTime() <=
          over.retentionDays * 86400000,
      `请求天数超过保留期应被裁剪: ${over.from} ~ ${over.to}`
    );
  });

  it('未配置分析 token 时平台用量端点明确不可用', async () => {
    const resp = await fetch(`${BASE_URL}/api/deno-analytics`);
    if (!process.env.DEPLOY_ANALYTICS_TOKEN && !process.env.DENO_API_TOKEN) {
      assert.equal(resp.status, 503);
      assert.equal((await resp.json()).success, false);
    } else {
      assert.equal(resp.status, 200);
    }
  });
});

describe('页面向量', () => {
  const pages = ['/', '/github', '/docker', '/packages', '/status'];
  for (const path of pages) {
    it(`${path} 返回 HTML`, async () => {
      const resp = await fetch(`${BASE_URL}${path}`);
      assert.equal(resp.status, 200);
      assert.match(resp.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await resp.text(), /<!doctype html/i);
    });
  }

  // 侧边目录由脚本按卡片生成：卡片缺少 id 就会静默少一项，这里在 SSR 阶段兜住
  it('/packages 每张服务卡片都带可跳转的锚点 id', async () => {
    const html = await (await fetch(`${BASE_URL}/packages`)).text();
    const cards = [...html.matchAll(/<div id="(pkg-[a-z]+)" class="toc-section/g)].map((m) => m[1]);
    assert.ok(cards.length >= 5, '未找到带 id 的服务卡片');
    assert.equal(
      [...html.matchAll(/class="toc-section/g)].length,
      cards.length,
      `存在缺少 id 的 toc-section：${[...html.matchAll(/class="toc-section/g)].length - cards.length} 个`
    );
    assert.match(html, /id="packages-toc"/);
    assert.match(html, /id="packages-toc-chips"/);
  });

  // 输入框上方的 label 已移除,可访问名称改由 aria-label 承担;清错一个就是读屏用户失去输入框名称
  it('/ 转换器输入框保留无障碍名称并带清除按钮', async () => {
    const html = await (await fetch(`${BASE_URL}/`)).text();
    assert.match(html, /id="url-input"[^>]*aria-label="待转换的源站链接"/);
    assert.match(html, /id="clear-input-btn"[^>]*aria-label="清除输入"/);
  });

  // 品牌资产少一件都是静默降级：爬虫拿到空分享卡、PWA 装不上、标签页没图标
  it('品牌元信息与静态资产齐备', async () => {
    const html = await (await fetch(`${BASE_URL}/`)).text();
    assert.match(html, /<title>[^<]*· 迅源 SwiftOrigin<\/title>/);
    assert.match(html, /property="og:image" content="[^"]*\/og-image\.jpg"/);
    assert.match(html, /property="og:site_name" content="迅源 SwiftOrigin"/);
    assert.match(html, /rel="canonical" href="http/);
    assert.match(html, /name="theme-color" content="#/);

    const magic: Record<string, number[]> = {
      '/favicon.ico': [0x00, 0x00, 0x01, 0x00],
      '/apple-touch-icon.png': [0x89, 0x50, 0x4e, 0x47],
      '/icons/icon-512.png': [0x89, 0x50, 0x4e, 0x47],
      '/og-image.jpg': [0xff, 0xd8, 0xff],
    };
    for (const [asset, head] of Object.entries(magic)) {
      const buf = new Uint8Array(await (await fetch(`${BASE_URL}${asset}`)).arrayBuffer());
      assert.deepEqual([...buf.slice(0, head.length)], head, `${asset} 不是预期的文件格式`);
    }

    const manifest = await (await fetch(`${BASE_URL}/manifest.webmanifest`)).json();
    assert.match(manifest.name, /迅源 SwiftOrigin/);
    assert.ok(manifest.icons?.length >= 2, 'manifest 图标不足');
    for (const icon of manifest.icons) {
      assert.equal((await fetch(`${BASE_URL}${icon.src}`)).status, 200, `${icon.src} 不可访问`);
    }
  });

  it('站内未知路由返回带品牌的 404 页', async () => {
    const resp = await fetch(`${BASE_URL}/definitely-not-a-page`);
    assert.equal(resp.status, 404);
    const html = await resp.text();
    assert.match(html, />404</);
    assert.match(html, /迅源 SwiftOrigin/);
  });
});

// 断言拿到的是上游真实响应,而非代理自身的网络错误(500/502)
// 上游偶发 429/503,退避重试后再判定
async function fetchUpstream(
  path: string,
  init?: RequestInit,
  attempts = 3
): Promise<Response> {
  let resp = await fetch(`${BASE_URL}${path}`, {
    headers: authHeaders(),
    ...init,
  });
  for (let i = 1; i < attempts && [429, 503].includes(resp.status); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1500 * i));
    resp = await fetch(`${BASE_URL}${path}`, {
      headers: authHeaders(),
      ...init,
    });
  }
  assert.ok(
    ![500, 502, 504].includes(resp.status),
    `proxy network failure for ${path} (${resp.status})`
  );
  return resp;
}

describe('GitHub 加速', () => {
  it('raw 文件代理成功', async () => {
    const resp = await fetchUpstream('/api/ghraw/octocat/Hello-World/master/README');
    assert.equal(resp.status, 200);
    assert.match(await resp.text(), /Hello World/);
    assert.ok(resp.headers.get('access-control-allow-origin'));
  });

  it('仓库页面代理成功', async () => {
    const upstreamPath = '/octocat/Hello-World/blob/master/README';
    const resp = await fetchUpstream(`/api/gh${upstreamPath}`);
    if ([200, 301, 302].includes(resp.status)) return;
    // github.com 对本机 IP 偶发 503;此时校验代理与直连结果一致(仅透传,非自身故障)
    const direct = await fetch(`https://github.com${upstreamPath}`, { redirect: 'manual' });
    assert.equal(resp.status, direct.status);
  });

  // git clone 的完整协商:info/refs 拿 HEAD sha,再 POST upload-pack 取 pack。
  // 带体转发缺 duplex 时 fetch 直接抛错(500),这条锁死该回归
  it('git clone 协议可代理(info/refs + upload-pack POST)', async () => {
    const adv = await fetchUpstream('/api/gh/octocat/Hello-World.git/info/refs?service=git-upload-pack');
    assert.equal(adv.status, 200);
    assert.match(adv.headers.get('content-type') ?? '', /x-git-upload-pack-advertisement/);
    const sha = (await adv.text()).match(/[0-9a-f]{40}/)?.[0];
    assert.ok(sha, 'advertisement 里应有 HEAD sha');

    // v1 协商第一轮:want + flush(GitHub 拒收单次带 done 的报文,直连同样 400,不能作代理断言)
    const pkt = (payload: string) => (payload.length + 10).toString(16).padStart(4, '0') + payload;
    const body = pkt(`want ${sha} side-band-64k ofs-delta\n`) + '0000';

    const resp = await fetchUpstream('/api/gh/octocat/Hello-World.git/git-upload-pack', {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'content-type': 'application/x-git-upload-pack-request',
        'user-agent': 'git/2.50.0',
      },
      body,
    });
    // 200 + upload-pack-result 即证明请求体被完整转发(缺 duplex 时这里是代理 500)
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') ?? '', /x-git-upload-pack-result/);
    await resp.arrayBuffer();
  });

  // 代理只做透传，不能把客户端的上游凭据吃掉或替换掉，否则带 token 的调用无法使用
  it('客户端自带的上游鉴权头透传到上游', async () => {
    const resp = await fetch(`${BASE_URL}/api/api.github.com/user`, {
      headers: { ...gateHeaders(), authorization: 'Bearer invalid-token-for-passthrough-test' },
    });
    assert.equal(resp.status, 401);
    assert.match(await resp.text(), /Bad credentials/);
  });

  it('未知前缀返回 404 JSON', async () => {
    const resp = await fetch(`${BASE_URL}/api/not-a-proxy-target`);
    assert.equal(resp.status, 404);
    assert.equal((await resp.json()).error, 'Not Found');
  });

  it('流量按真实写出字节计入统计', async () => {
    const resp = await fetchUpstream('/api/ghraw/octocat/Hello-World/master/README');
    const body = await resp.text();
    // 响应体流结束后才记账,留一拍等中间件落库
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stats = await (await fetch(`${BASE_URL}/api/stats`)).json();
    const gh = stats.today.github;
    assert.ok(gh.requests > 0, `requests should be counted: ${JSON.stringify(stats.today)}`);
    assert.ok(gh.uses > 0, `raw 文件下载应计入使用次数: ${JSON.stringify(stats.today)}`);
    assert.ok(
      gh.bytes >= body.length,
      `bytes should count the streamed body: ${gh.bytes} < ${body.length}`
    );
  });
});

describe('Docker 加速', () => {
  it('/v2/ 可达(200 或 401)', async () => {
    const resp = await fetchUpstream('/v2/');
    assert.ok([200, 401].includes(resp.status), `unexpected status ${resp.status}`);
  });

  // docker pull 的真实链路:index manifest → 子 manifest → layer blob，
  // 每一跳都要带 accept 头并由代理自动补签 token，任何一跳断掉镜像就拉不下来
  it('/v2/ 可完成 manifest 到 blob 的完整拉取链路', async () => {
    const idx = await fetchUpstream('/v2/library/nginx/manifests/latest', {
      headers: { ...authHeaders(), accept: 'application/vnd.oci.image.index.v1+json' },
    });
    assert.equal(idx.status, 200);
    const index = await idx.json();
    assert.ok(index.manifests?.length, 'index 应列出子 manifest');

    const childDigest = index.manifests[0].digest;
    const child = await fetchUpstream(`/v2/library/nginx/manifests/${childDigest}`, {
      headers: { ...authHeaders(), accept: 'application/vnd.oci.image.manifest.v1+json' },
    });
    assert.equal(child.status, 200);
    const manifest = await child.json();
    assert.ok(manifest.layers?.length, '子 manifest 应列出 layer');

    // Range 跳验证 blob 透传：只取前 1KB，证明代理拿到的是上游真实 blob 而非错误页
    const blob = await fetchUpstream(`/v2/library/nginx/blobs/${manifest.layers[0].digest}`, {
      headers: { ...authHeaders(), range: 'bytes=0-1023' },
    });
    assert.ok([200, 206].includes(blob.status), `blob status ${blob.status}`);
    assert.ok((await blob.arrayBuffer()).byteLength > 0, 'blob 应有实际字节');
  });

  // push 的 blob 上传是带体 POST。代理内部补签的 token 只有 pull 权限，
  // 若像早年那样丢掉 body 再自行重试，上游会回 4xx 协议错误而不是标准挑战；
  // 因此断言拿到的是原样透传的 www-authenticate，交给客户端带权限重发
  it('/v2/ 带体 POST 透传上游鉴权挑战', async () => {
    const resp = await fetchUpstream('/v2/library/nginx/blobs/uploads/', {
      method: 'POST',
      body: 'x'.repeat(64),
      headers: { ...gateHeaders(), 'content-type': 'application/octet-stream' },
    });
    assert.equal(resp.status, 401);
    assert.match(resp.headers.get('www-authenticate') ?? '', /Bearer realm=/);
    assert.match(await resp.text(), /UNAUTHORIZED/);
  });

  it('/api/ghcr/ 镜像端点可达', async () => {
    const resp = await fetchUpstream('/api/ghcr/v2/');
    assert.ok([200, 401].includes(resp.status), `unexpected status ${resp.status}`);
  });

  it('/api/mcr/ 镜像端点可达', async () => {
    const resp = await fetchUpstream('/api/mcr/v2/');
    assert.ok([200, 401].includes(resp.status), `unexpected status ${resp.status}`);
  });
});

describe('Packages 加速', () => {
  it('/api/npm/ 包元数据代理成功', async () => {
    const resp = await fetchUpstream('/api/npm/mime');
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.name, 'mime');
    // 官方源元数据含绝对 tarball URL，代理必须重写回本前缀，否则下载绕过加速直连官方源
    const latest = data['dist-tags']?.latest;
    const tarball: string | undefined = data.versions?.[latest]?.dist?.tarball;
    assert.ok(tarball, 'missing dist.tarball');
    assert.ok(tarball?.startsWith(`${BASE_URL}/api/npm/`), `tarball not rewritten: ${tarball}`);
    assert.ok(!JSON.stringify(data).includes('https://registry.npmjs.org'), 'unrewritten official URL remains');
  });

  it('/api/goproxy/ 版本列表代理成功', async () => {
    const resp = await fetchUpstream('/api/goproxy/github.com/gorilla/mux/@v/list');
    assert.equal(resp.status, 200);
    assert.match(await resp.text(), /v1\./);
  });

  it('/api/goproxy/sumdb/ 校验库转发成功', async () => {
    const resp = await fetchUpstream(
      '/api/goproxy/sumdb/sum.golang.org/lookup/github.com/gorilla/mux@v1.8.0'
    );
    assert.equal(resp.status, 200);
    assert.match(await resp.text(), /github.com\/gorilla\/mux v1\.8\.0 /);
  });

  it('/api/jsd/ 资源代理成功', async () => {
    const resp = await fetchUpstream('/api/jsd/npm/mime/package.json');
    assert.equal(resp.status, 200);
    const data = await resp.json();
    assert.equal(data.name, 'mime');
  });

  it('/api/maven/ 构件代理成功', async () => {
    const resp = await fetchUpstream('/api/maven/maven2/junit/junit/4.13.2/junit-4.13.2.pom');
    assert.equal(resp.status, 200);
    assert.match(await resp.text(), /<artifactId>junit<\/artifactId>/);
  });

  it('/api/gmaven/ 构件代理成功', async () => {
    const resp = await fetchUpstream('/api/gmaven/android/maven2/com/android/tools/build/gradle/8.5.0/gradle-8.5.0.pom');
    assert.equal(resp.status, 200);
    assert.match(await resp.text(), /<artifactId>gradle<\/artifactId>/);
  });

  it('/api/pypi/ simple 索引内的下载地址改写回本代理', async () => {
    const resp = await fetchUpstream('/api/pypi/simple/six/');
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assert.match(html, /<a href="[^"]*\/api\/pyf\/packages\//, 'wheel links should point at the proxy');
    assert.ok(!html.includes('https://files.pythonhosted.org'), 'unrewritten files.pythonhosted.org URL remains');

    // 改写后的链接必须可直达，且 sha256 片段保留（pip 依赖它做完整性校验）
    const link = html.match(/<a href="([^"]+\/six-[^"]*\.whl#sha256=[0-9a-f]{64})"/)![1];
    const wheel = await fetchUpstream(link.slice(BASE_URL.length));
    assert.equal(wheel.status, 200);
    assert.ok((await wheel.arrayBuffer()).byteLength > 0);
  });

  it('/api/unpkg/ 未指定版本时 302 改写回本代理并可继续取文件', async () => {
    const resp = await fetchUpstream('/api/unpkg/mime/package.json', { redirect: 'manual' });
    assert.ok([200, 301, 302, 307, 308].includes(resp.status), `unexpected status ${resp.status}`);
    if (resp.status !== 200) {
      const location = resp.headers.get('location') || '';
      // 同源重定向必须留在代理前缀内，否则下一跳绕过代理直连 unpkg
      assert.ok(location.startsWith('/api/unpkg/'), `redirect not rewritten: ${location}`);
      assert.ok(!location.includes('//'), `double slash in rewritten location: ${location}`);
      const followed = await fetchUpstream(location);
      assert.equal(followed.status, 200);
      assert.equal((await followed.json()).name, 'mime');
      return;
    }
    assert.equal((await resp.json()).name, 'mime');
  });

  for (const svc of ['github', 'docker', 'npm', 'go', 'jsd', 'unpkg', 'maven', 'mcr', 'pypi']) {
    it(`/api/status/${svc} 返回结构化结果`, async () => {
      const resp = await fetch(`${BASE_URL}/api/status/${svc}`);
      assert.equal(resp.status, 200);
      const data = await resp.json();
      assert.ok(['ok', 'error'].includes(data.status), `bad status: ${data.status}`);
      assert.equal(typeof data.responseTime, 'number');
    });
  }

  it('/api/status 一次返回全部服务的探测结果', async () => {
    const data = await (await fetch(`${BASE_URL}/api/status`)).json();
    assert.deepEqual(
      Object.keys(data.services).sort(),
      ['docker', 'github', 'go', 'jsd', 'maven', 'mcr', 'npm', 'pypi', 'unpkg']
    );
    for (const [service, result] of Object.entries<any>(data.services)) {
      assert.ok(['ok', 'error'].includes(result.status), `${service}: ${result.status}`);
      assert.equal(typeof result.responseTime, 'number');
    }
  });

  it('批量端点与单服务端点共用同一份探测缓存', async () => {
    // 同 key(status:npm) 若各打一次上游，timestamp 会不同
    const single = await (await fetch(`${BASE_URL}/api/status/npm`)).json();
    const batched = await (await fetch(`${BASE_URL}/api/status`)).json();
    assert.equal(batched.services.npm.timestamp, single.timestamp, 'probe cache not shared');
  });

  it('探测结果在服务端缓存，重复请求不重复出网', async () => {
    // timestamp 记录的是真正回源的时刻，TTL 内多次请求应拿到同一时刻
    const [a, b] = await Promise.all([
      (await fetch(`${BASE_URL}/api/status/npm`)).json(),
      (await fetch(`${BASE_URL}/api/status/npm`)).json(),
    ]);
    const c = await (await fetch(`${BASE_URL}/api/status/npm`)).json();
    assert.equal(a.timestamp, b.timestamp, 'concurrent probes not coalesced');
    assert.equal(b.timestamp, c.timestamp, 'sequential probe re-went upstream');
  });

  it('未知服务状态端点返回 404', async () => {
    const resp = await fetch(`${BASE_URL}/api/status/not-a-service`);
    assert.equal(resp.status, 404);
  });
});

// 仅当启动服务器时设置了 PROXY_PASSWORD 才验证鉴权行为
if (PROXY_PASSWORD) {
  describe('Basic Auth', () => {
    it('缺少凭据时代理请求返回 401', async () => {
      const resp = await fetch(
        `${BASE_URL}/api/ghraw/octocat/Hello-World/master/README`
      );
      assert.equal(resp.status, 401);
      assert.match(resp.headers.get('www-authenticate') ?? '', /Basic/);
    });

    it('错误密码返回 403', async () => {
      const token = Buffer.from('proxy:wrong-password').toString('base64');
      const resp = await fetch(
        `${BASE_URL}/api/ghraw/octocat/Hello-World/master/README`,
        { headers: { authorization: `Basic ${token}` } }
      );
      assert.equal(resp.status, 403);
    });

    it('主页无需凭据即可访问', async () => {
      const resp = await fetch(`${BASE_URL}/`);
      assert.equal(resp.status, 200);
    });

    // authorization 只有一个，门禁与上游凭据不能同时挤它：门禁另走 x-proxy-key
    it('x-proxy-key 通过门禁且不占用 authorization', async () => {
      const resp = await fetch(
        `${BASE_URL}/api/ghraw/octocat/Hello-World/master/README`,
        { headers: { 'x-proxy-key': PROXY_PASSWORD } }
      );
      assert.equal(resp.status, 200);
    });

    it('x-proxy-key 错误返回 403', async () => {
      const resp = await fetch(
        `${BASE_URL}/api/ghraw/octocat/Hello-World/master/README`,
        { headers: { 'x-proxy-key': 'wrong-key' } }
      );
      assert.equal(resp.status, 403);
    });

    // 门禁密码发给上游 = 泄漏密码，且会让上游把请求判成坏凭据。
    // 用 /user 而非配额端点：后者在配置 GITHUB_TOKEN 时会被注入身份，干扰本用例断言
    it('Basic 门禁凭据不透传给上游', async () => {
      const resp = await fetch(`${BASE_URL}/api/api.github.com/user`, {
        headers: authHeaders(),
      });
      assert.notEqual(resp.status, 200);
      // 上游看到的是匿名请求；若把 proxy:密码 发了过去，它会判成坏凭据
      assert.doesNotMatch(await resp.text(), /Bad credentials/);
    });

    it('x-proxy-key 门禁下客户端上游凭据仍抵达上游', async () => {
      const resp = await fetch(`${BASE_URL}/api/api.github.com/user`, {
        headers: {
          'x-proxy-key': PROXY_PASSWORD,
          authorization: 'Bearer invalid-token-for-passthrough-test',
        },
      });
      assert.equal(resp.status, 401);
      assert.match(await resp.text(), /Bad credentials/);
    });
  });
}

// 仅当启动服务器时设置了 GITHUB_TOKEN 才验证配额注入（token 真假都可跑）
if (process.env.GITHUB_TOKEN) {
  describe('GitHub API 配额注入', () => {
    // 注入生效只有两种形态：token 可用 -> 认证配额 5000；token 不可用 -> 上游拒该身份。
    // 都不该退回匿名配额，否则说明共享出口 IP 的 60 次/时限制没被绕开
    it('公开仓库与配额端点使用注入身份', async () => {
      const resp = await fetchUpstream('/api/api.github.com/rate_limit');
      const body = await resp.text();
      if (resp.status === 401) {
        assert.match(body, /Bad credentials/);
        return;
      }
      assert.equal(resp.status, 200);
      assert.equal(JSON.parse(body).resources.core.limit, 5000);
    });

    // 账号端点必须以匿名身份发出：否则代理访客能借这个 token 读到账号自身的数据
    it('账号端点不注入身份', async () => {
      const resp = await fetchUpstream('/api/api.github.com/user');
      const body = await resp.text();
      // 注入时上游会用该身份应答（token 可用则 200，不可用则 Bad credentials）；
      // 不注入才是「要求认证」或匿名配额耗尽
      assert.notEqual(resp.status, 200, `账号端点被注入了身份: ${body.slice(0, 120)}`);
      assert.doesNotMatch(body, /Bad credentials/);
    });

    // 注入的是本站身份，其 scope 回显不该转给客户端
    it('不透出注入身份的 scope', async () => {
      const resp = await fetchUpstream('/api/api.github.com/rate_limit');
      await resp.arrayBuffer();
      assert.equal(resp.headers.get('x-oauth-scopes'), null);
    });
  });
}
