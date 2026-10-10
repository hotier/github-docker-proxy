// 日分割固定按东八区自然日。
// 运行实例时区不可依赖：Deno Deploy 实例跑在 UTC，若用本地时区取日，"今日"要到
// 北京时间 08:00 才翻页；本站用户都在东八区，所以统一用固定 +08:00（中国无夏令时）。

export const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

// 任意时刻(UTC 毫秒) -> 所属东八区自然日 'YYYY-MM-DD'
export function cnDay(at: number): string {
  const d = new Date(at + CN_OFFSET_MS);
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const date = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${month}-${date}`;
}

// 任意时刻(UTC 毫秒) -> 所在东八区自然日 00:00 的 UTC 毫秒
export function cnDayStart(at: number): number {
  const [year, month, date] = cnDay(at).split('-').map(Number);
  return Date.UTC(year, month - 1, date) - CN_OFFSET_MS;
}
