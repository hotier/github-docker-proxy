// Deno KV 句柄的唯一获取点。
// Deploy 把已连接的实例注入全局 Deno.Kv，这里每次调用都重读全局：注入的句柄本身没有
// 建立成本，而测试会替换/删除 globalThis.Deno，记死一次会让用例之间共用同一份 KV。
// 只有 openKv()（本地 Deno run）需要建立连接，因此只把它记下来复用。
// 没有 KV 的环境（本地 dev、node 测试）返回 null，调用方各自退回内存实现。

let opened: Promise<any> | null = null;

export async function getKv(): Promise<any | null> {
  const deno = (globalThis as any).Deno;
  try {
    if (deno?.Kv && typeof deno.Kv.get === 'function') return deno.Kv;
    if (typeof deno?.openKv === 'function') return (opened ??= deno.openKv());
  } catch (error) {
    console.warn('Deno KV 不可用，使用内存后端:', error);
  }
  return null;
}
