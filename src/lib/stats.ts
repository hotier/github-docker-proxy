// 统计工具库 - 支持 Deno KV 和 SQLite
// 按节点分类统计，只统计代理请求

import Database from 'better-sqlite3';
import { join } from 'path';
import fs from 'fs';

// 统计数据结构
interface NodeStats {
  requests: number;
  bytes: number;
  lastUpdated: number;
}

interface DailyStats {
  date: string;
  github: NodeStats;
  docker: NodeStats;
  other: NodeStats;
}

interface StatsData {
  total: {
    github: NodeStats;
    docker: NodeStats;
    other: NodeStats;
  };
  today: DailyStats;
  weekly: Array<{
    date: string;
    requests: number;
    bytes: number;
  }>;
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
    
    // 创建节点统计表
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS node_stats (
        node_type TEXT NOT NULL,
        stat_type TEXT NOT NULL,
        stat_key TEXT NOT NULL,
        requests INTEGER DEFAULT 0,
        bytes INTEGER DEFAULT 0,
        lastUpdated INTEGER,
        PRIMARY KEY (node_type, stat_type, stat_key)
      );
      
      CREATE INDEX IF NOT EXISTS idx_node_stats ON node_stats(node_type, stat_type, stat_key);
    `);
    
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

// 判断节点类型
export function getNodeType(path: string): 'github' | 'docker' | 'other' {
  if (path.startsWith('/api/gh/') || path.startsWith('/api/ghraw/') || 
      path.startsWith('/api/codeload/') || path.startsWith('/api/objects/') ||
      path.startsWith('/api/release-assets/') || path.startsWith('/api/api.github.com/')) {
    return 'github';
  }
  if (path.startsWith('/v2/') || path.startsWith('/api/ghcr/') || 
      path.startsWith('/api/gcr/') || path.startsWith('/api/k8s/') || 
      path.startsWith('/api/quay/')) {
    return 'docker';
  }
  return 'other';
}

// 更新统计数据
export async function updateStats(path: string, bytes: number): Promise<void> {
  const nodeType = getNodeType(path);
  const now = Date.now();
  const today = getTodayKey();

  // 尝试使用 Deno KV（生产环境）
  const kv = await getKV();
  if (kv) {
    try {
      // 更新累计统计
      const totalKey = ['stats', 'total', nodeType];
      const total = await kv.get<NodeStats>(totalKey);
      
      await kv.set(totalKey, {
        requests: (total.value?.requests || 0) + 1,
        bytes: (total.value?.bytes || 0) + bytes,
        lastUpdated: now
      });

      // 更新今日统计
      const dailyKey = ['stats', 'daily', today, nodeType];
      const daily = await kv.get<NodeStats>(dailyKey);
      
      await kv.set(dailyKey, {
        requests: (daily.value?.requests || 0) + 1,
        bytes: (daily.value?.bytes || 0) + bytes,
        lastUpdated: now
      });

      kv.close();
      return;
    } catch (error) {
      console.error('KV update failed:', error);
    }
  }

  // 使用 SQLite（本地开发）
  const db = getSQLite();
  if (!db) return;

  try {
    // 更新累计统计
    db.prepare(`
      INSERT INTO node_stats (node_type, stat_type, stat_key, requests, bytes, lastUpdated)
      VALUES (?, 'total', 'all', 1, ?, ?)
      ON CONFLICT(node_type, stat_type, stat_key) DO UPDATE SET
        requests = requests + 1,
        bytes = bytes + ?,
        lastUpdated = ?
    `).run(nodeType, bytes, now, bytes, now);

    // 更新今日统计
    db.prepare(`
      INSERT INTO node_stats (node_type, stat_type, stat_key, requests, bytes, lastUpdated)
      VALUES (?, 'daily', ?, 1, ?, ?)
      ON CONFLICT(node_type, stat_type, stat_key) DO UPDATE SET
        requests = requests + 1,
        bytes = bytes + ?,
        lastUpdated = ?
    `).run(nodeType, today, bytes, now, bytes, now);

    // 清理 30 天前的数据
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoffDate = thirtyDaysAgo.toISOString().split('T')[0];
    
    db.prepare(`
      DELETE FROM node_stats 
      WHERE stat_type = 'daily' AND stat_key < ?
    `).run(cutoffDate);
  } catch (error) {
    console.error('SQLite update failed:', error);
  }
}

// 获取统计数据
export async function getStats(): Promise<StatsData> {
  const today = getTodayKey();
  const kv = await getKV();

  if (kv) {
    try {
      // 获取各节点累计统计
      const githubTotal = await kv.get<NodeStats>(['stats', 'total', 'github']);
      const dockerTotal = await kv.get<NodeStats>(['stats', 'total', 'docker']);
      const otherTotal = await kv.get<NodeStats>(['stats', 'total', 'other']);

      // 获取各节点今日统计
      const githubToday = await kv.get<NodeStats>(['stats', 'daily', today, 'github']);
      const dockerToday = await kv.get<NodeStats>(['stats', 'daily', today, 'docker']);
      const otherToday = await kv.get<NodeStats>(['stats', 'daily', today, 'other']);

      kv.close();

      return {
        total: {
          github: githubTotal.value || { requests: 0, bytes: 0, lastUpdated: Date.now() },
          docker: dockerTotal.value || { requests: 0, bytes: 0, lastUpdated: Date.now() },
          other: otherTotal.value || { requests: 0, bytes: 0, lastUpdated: Date.now() }
        },
        today: {
          date: today,
          github: githubToday.value || { requests: 0, bytes: 0, lastUpdated: Date.now() },
          docker: dockerToday.value || { requests: 0, bytes: 0, lastUpdated: Date.now() },
          other: otherToday.value || { requests: 0, bytes: 0, lastUpdated: Date.now() }
        },
        weekly: await getWeeklyStatsKV(kv)
      };
    } catch (error) {
      console.error('KV get failed:', error);
    }
  }

  // 使用 SQLite（本地开发）
  const db = getSQLite();
  if (!db) return getDefaultStats(today);

  try {
    // 获取累计统计
    const getTotal = (nodeType: string) => {
      const row = db.prepare(`
        SELECT requests, bytes, lastUpdated 
        FROM node_stats 
        WHERE node_type = ? AND stat_type = 'total' AND stat_key = 'all'
      `).get(nodeType) as any;
      
      return row ? {
        requests: row.requests,
        bytes: row.bytes,
        lastUpdated: row.lastUpdated
      } : { requests: 0, bytes: 0, lastUpdated: Date.now() };
    };

    // 获取今日统计
    const getDaily = (nodeType: string) => {
      const row = db.prepare(`
        SELECT requests, bytes, lastUpdated 
        FROM node_stats 
        WHERE node_type = ? AND stat_type = 'daily' AND stat_key = ?
      `).get(nodeType, today) as any;
      
      return row ? {
        requests: row.requests,
        bytes: row.bytes,
        lastUpdated: row.lastUpdated
      } : { requests: 0, bytes: 0, lastUpdated: Date.now() };
    };

    return {
      total: {
        github: getTotal('github'),
        docker: getTotal('docker'),
        other: getTotal('other')
      },
      today: {
        date: today,
        github: getDaily('github'),
        docker: getDaily('docker'),
        other: getDaily('other')
      },
      weekly: getWeeklyStatsSQLite(db)
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
    
    // 获取当天的所有节点统计
    const github = await kv.get<NodeStats>(['stats', 'daily', dateStr, 'github']);
    const docker = await kv.get<NodeStats>(['stats', 'daily', dateStr, 'docker']);
    const other = await kv.get<NodeStats>(['stats', 'daily', dateStr, 'other']);
    
    const totalRequests = (github.value?.requests || 0) + (docker.value?.requests || 0) + (other.value?.requests || 0);
    const totalBytes = (github.value?.bytes || 0) + (docker.value?.bytes || 0) + (other.value?.bytes || 0);
    
    stats.push({
      date: dateStr,
      requests: totalRequests,
      bytes: totalBytes
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
    
    const row = db.prepare(`
      SELECT SUM(requests) as requests, SUM(bytes) as bytes
      FROM node_stats
      WHERE stat_type = 'daily' AND stat_key = ?
    `).get(dateStr) as any;
    
    stats.push({
      date: dateStr,
      requests: row?.requests || 0,
      bytes: row?.bytes || 0
    });
  }

  return stats;
}

// 默认统计数据
function getDefaultStats(today: string): StatsData {
  const empty = { requests: 0, bytes: 0, lastUpdated: Date.now() };
  return {
    total: { github: empty, docker: empty, other: empty },
    today: { date: today, github: empty, docker: empty, other: empty },
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
