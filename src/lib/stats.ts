// 统计工具库 - 支持 Deno KV 和 SQLite

import Database from 'better-sqlite3';
import { join } from 'path';
import fs from 'fs';

// 统计数据结构
interface StatsData {
  requests: number;
  bytes: number;
  lastUpdated: number;
}

interface DailyStats extends StatsData {
  date: string;
}

// SQLite 数据库实例
let sqliteDb: Database.Database | null = null;

// 初始化 SQLite
function getSQLite(): Database.Database | null {
  if (sqliteDb) return sqliteDb;
  
  try {
    const dbPath = join(process.cwd(), 'data', 'stats.db');
    const dir = join(process.cwd(), 'data');
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    sqliteDb = new Database(dbPath);
    
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS stats_total (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        requests INTEGER DEFAULT 0,
        bytes INTEGER DEFAULT 0,
        lastUpdated INTEGER
      );
      
      CREATE TABLE IF NOT EXISTS stats_daily (
        date TEXT PRIMARY KEY,
        requests INTEGER DEFAULT 0,
        bytes INTEGER DEFAULT 0,
        lastUpdated INTEGER
      );
      
      CREATE INDEX IF NOT EXISTS idx_date ON stats_daily(date);
    `);
    
    sqliteDb.prepare(`
      INSERT OR IGNORE INTO stats_total (id, requests, bytes, lastUpdated)
      VALUES (1, 0, 0, ?)
    `).run(Date.now());
    
    console.log('SQLite database initialized at:', dbPath);
    return sqliteDb;
  } catch (error) {
    console.error('Failed to initialize SQLite:', error);
    return null;
  }
}

// 获取 KV 实例（生产环境）
async function getKV(): Promise<any | null> {
  try {
    if (typeof (globalThis as any).Deno !== 'undefined' && (globalThis as any).Deno.openKv) {
      return await (globalThis as any).Deno.openKv();
    }
  } catch (error) {
    // KV 不可用，使用 SQLite
  }
  return null;
}

// 获取今日日期字符串（本地时区）
function getTodayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 更新统计数据
export async function updateStats(bytes: number): Promise<void> {
  const now = Date.now();
  const today = getTodayKey();

  // 尝试使用 Deno KV（生产环境）
  const kv = await getKV();
  if (kv) {
    try {
      const totalKey = ['stats', 'total'];
      const total = await kv.get<StatsData>(totalKey);
      
      await kv.set(totalKey, {
        requests: (total.value?.requests || 0) + 1,
        bytes: (total.value?.bytes || 0) + bytes,
        lastUpdated: now
      });

      const dailyKey = ['stats', 'daily', today];
      const daily = await kv.get<DailyStats>(dailyKey);
      
      await kv.set(dailyKey, {
        requests: (daily.value?.requests || 0) + 1,
        bytes: (daily.value?.bytes || 0) + bytes,
        lastUpdated: now,
        date: today
      });

      kv.close();
      return;
    } catch (error) {
      console.error('KV update failed, falling back to SQLite:', error);
    }
  }

  // 使用 SQLite（本地开发）
  const db = getSQLite();
  if (!db) return;

  try {
    db.prepare(`
      UPDATE stats_total 
      SET requests = requests + 1, 
          bytes = bytes + ?, 
          lastUpdated = ?
      WHERE id = 1
    `).run(bytes, now);

    db.prepare(`
      INSERT INTO stats_daily (date, requests, bytes, lastUpdated)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        requests = requests + 1,
        bytes = bytes + ?,
        lastUpdated = ?
    `).run(today, bytes, now, bytes, now);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoffDate = thirtyDaysAgo.toISOString().split('T')[0];
    
    db.prepare('DELETE FROM stats_daily WHERE date < ?').run(cutoffDate);
  } catch (error) {
    console.error('SQLite update failed:', error);
  }
}

// 获取统计数据
export async function getStats() {
  const today = getTodayKey();
  const kv = await getKV();

  if (kv) {
    try {
      const total = await kv.get<StatsData>(['stats', 'total']);
      const daily = await kv.get<DailyStats>(['stats', 'daily', today]);
      const weekly = await getWeeklyStatsKV(kv);

      kv.close();

      return {
        total: total.value || { requests: 0, bytes: 0, lastUpdated: Date.now() },
        today: daily.value || { requests: 0, bytes: 0, lastUpdated: Date.now(), date: today },
        weekly
      };
    } catch (error) {
      console.error('KV get failed:', error);
    }
  }

  const db = getSQLite();
  if (!db) return getDefaultStats(today);

  try {
    const total = db.prepare('SELECT * FROM stats_total WHERE id = 1').get() as any;
    const daily = db.prepare('SELECT * FROM stats_daily WHERE date = ?').get(today) as any;
    const weekly = getWeeklyStatsSQLite(db);

    return {
      total: {
        requests: total?.requests || 0,
        bytes: total?.bytes || 0,
        lastUpdated: total?.lastUpdated || Date.now()
      },
      today: daily ? {
        requests: daily.requests,
        bytes: daily.bytes,
        lastUpdated: daily.lastUpdated,
        date: daily.date
      } : { requests: 0, bytes: 0, lastUpdated: Date.now(), date: today },
      weekly
    };
  } catch (error) {
    console.error('SQLite get failed:', error);
    return getDefaultStats(today);
  }
}

// 获取最近 7 天统计（KV）
async function getWeeklyStatsKV(kv: any) {
  const stats = [];
  const now = new Date();

  for (let i = 6; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    
    const data = await kv.get<DailyStats>(['stats', 'daily', dateStr]);
    
    stats.push({
      date: dateStr,
      requests: data.value?.requests || 0,
      bytes: data.value?.bytes || 0
    });
  }

  return stats;
}

// 获取最近 7 天统计（SQLite）
function getWeeklyStatsSQLite(db: Database.Database) {
  const stats = [];
  const now = new Date();

  for (let i = 6; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    
    const data = db.prepare('SELECT * FROM stats_daily WHERE date = ?').get(dateStr) as any;
    
    stats.push({
      date: dateStr,
      requests: data?.requests || 0,
      bytes: data?.bytes || 0
    });
  }

  return stats;
}

// 默认统计数据
function getDefaultStats(today: string) {
  return {
    total: { requests: 0, bytes: 0, lastUpdated: Date.now() },
    today: { requests: 0, bytes: 0, lastUpdated: Date.now(), date: today },
    weekly: []
  };
}

// 格式化字节数
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 格式化数字（添加千分位）
export function formatNumber(num: number): string {
  return num.toLocaleString('zh-CN');
}
