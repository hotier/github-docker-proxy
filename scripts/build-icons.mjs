// 图标引擎:better-icons (Iconify API)
// 扫描 src/ 中所有 icon-[prefix--name] 类名,通过 better-icons CLI 拉取 SVG,
// 生成 src/styles/icons.generated.css(纯 CSS mask,零客户端 JS,currentColor 主题色)。
// 用法: npm run icons
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('src');
const OUT = path.join(SRC, 'styles', 'icons.generated.css');
const ICON_RE = /icon-\[([a-z0-9-]+)--([a-z0-9-]+)\]/g;

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(astro|ts|tsx|js|css)$/.test(e.name) && p !== OUT) yield p;
  }
}

const ids = new Set();
for (const file of walk(SRC)) {
  for (const m of readFileSync(file, 'utf8').matchAll(ICON_RE)) {
    ids.add(`${m[1]}:${m[2]}`);
  }
}
if (ids.size === 0) {
  console.error('未找到任何 icon-[prefix--name] 类名');
  process.exit(1);
}

const rules = [];
for (const id of [...ids].sort()) {
  // Windows 下 better-icons 是 .cmd,需要 shell;图标 id 来自源码扫描的 [a-z0-9-] 白名单
  const svg = execFileSync('better-icons', ['get', id], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).trim();
  if (!svg.startsWith('<svg')) {
    console.error(`获取失败: ${id}`);
    process.exit(1);
  }
  const prepared = svg
    .replace(/\s(?:width|height)="1em"/g, '')
    .replace(/fill="currentColor"/g, 'fill="#000"');
  const encoded = encodeURIComponent(prepared);
  const cls = id.replace(':', '--');
  rules.push(
    `.icon-\\[${cls}\\]{display:inline-block;width:1em;height:1em;vertical-align:-0.125em;background-color:currentColor;-webkit-mask:url("data:image/svg+xml,${encoded}") no-repeat center/contain;mask:url("data:image/svg+xml,${encoded}") no-repeat center/contain;}`
  );
}

writeFileSync(
  OUT,
  `/* 自动生成:node scripts/build-icons.mjs (better-icons),勿手改 */\n${rules.join('\n')}\n`
);
console.log(`已生成 ${rules.length} 个图标 -> ${path.relative('.', OUT)}`);
