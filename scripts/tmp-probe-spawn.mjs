import { spawn } from 'node:child_process';

const env = { ...process.env };
delete env.DENO_API_TOKEN;
const p = spawn(process.execPath, ['node_modules/astro/bin/astro.mjs', 'dev', '--port', '4399', '--ignore-lock'], {
  stdio: 'ignore',
  env,
});
p.on('exit', (code, sig) => console.log('exit', code, sig));
p.on('error', (e) => console.log('spawn error', e.message));

const t0 = Date.now();
let ticks = 0;
const iv = setInterval(async () => {
  ticks++;
  try {
    const r = await fetch('http://localhost:4399/api/health', { signal: AbortSignal.timeout(2000) });
    console.log(`healthy after ${Date.now() - t0}ms status=${r.status}`);
    clearInterval(iv);
    p.kill();
    process.exit(0);
  } catch (e) {
    if (ticks % 6 === 0) console.log(`waiting ${Date.now() - t0}ms: ${e.message}`);
  }
  if (Date.now() - t0 > 60000) {
    console.log('TIMEOUT 60s');
    clearInterval(iv);
    p.kill();
    process.exit(1);
  }
}, 500);
