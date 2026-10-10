// 跨冷启动共享的结果缓存。
// probe.ts 的进程内缓存每次冷启动都是空的，而实测每小时有上百次冷启动：新实例的第一批请求
// 必然回源，回源越贵（解析上千个平台用量桶、再聚合日桶）烧掉的 CPU 越多。
// 这里在进程内缓存之后、执行 producer 之前插入一层 Deno KV：命中就免去回源，未命中才真正取数，
// 并把结果写回 KV 用 expireIn 做 TTL——同一份内容在实例间只算一次。
// 只放小体积且可公开给所有访客的 JSON（KV 单值上限 64 KiB，原始调试数组不要进来）。
// 没有 KV 的环境（本地 dev、node 测试）自动退化为 probe.ts 的进程内缓存行为。

import { getKv } from './kv.ts';

type Entry = { at: number; data: unknown };

const KEY_PREFIX = ['shared-cache'];

// 进程内一层，避免每次到期轮询都付一次 KV 读
const local = new Map<string, Entry>();
// 同一实例上的并发请求复用在途任务，同一个 key 只回源一次
const pending = new Map<string, Promise<unknown>>();

// producer 抛错时不写缓存，下个请求即重试
// force（手动刷新按钮）跳过两层缓存直接回源，但并发 force 仍共享同一次取数
export async function cachedJsonShared(
  key: string,
  ttlMs: number,
  producer: () => Promise<unknown>,
  force = false
): Promise<unknown> {
  const hit = local.get(key);
  if (!force && hit && Date.now() - hit.at < ttlMs) return hit.data;

  const running = pending.get(key);
  if (running) return running;

  const task = (async () => {
    if (!force) {
      const shared = await readShared(key);
      if (shared) {
        local.set(key, shared);
        return shared.data;
      }
    }
    const data = await producer();
    const entry = { at: Date.now(), data };
    local.set(key, entry);
    await writeShared(key, entry, ttlMs);
    return data;
  })().finally(() => {
    pending.delete(key);
  });

  pending.set(key, task);
  return task;
}

// 读不到就当未命中：KV 故障不能让看板跟着挂掉，回源即可
async function readShared(key: string): Promise<Entry | undefined> {
  const kv = await getKv();
  if (!kv) return undefined;
  try {
    const { value } = await kv.get([...KEY_PREFIX, key]);
    return value && typeof value.at === 'number' ? (value as Entry) : undefined;
  } catch (error) {
    console.warn('Shared cache read failed, refetching:', error);
    return undefined;
  }
}

// 写失败只损失下一次命中率，不影响本次结果
async function writeShared(key: string, entry: Entry, ttlMs: number): Promise<void> {
  const kv = await getKv();
  if (!kv) return;
  try {
    await kv.set([...KEY_PREFIX, key], entry, { expireIn: ttlMs });
  } catch (error) {
    console.warn('Shared cache write failed:', error);
  }
}
