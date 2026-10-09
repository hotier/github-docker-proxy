// 统计工具库 - 主站访问统计和服务加速统计
// 主站访问：带防刷机制（同 IP+设备指纹短期限制）
// 服务加速：统计 GitHub/Docker 的真实加速请求

import Database from 'better-sqlite3';
import { join } from 'path';
import fs from 'fs';
import crypto from 'crypto';

// 统计数据结构
interface VisitRecord {
  id?: number;
  visitor_hash: string;  // IP + User-Agent 哈希
  ip: string;
  user_agent: string;
  path: string;
  first_visit: number;   // 首次访问时间
  last_visit: number;    // 最后访问时间
  visit_count: number;   // 访问次数
  date: string;          // 日期 YYYY-MM-DD
}

interface DailyStats {
  date: string;
  main_visits: number;      // 主站访问次数（已去重）
  main_visitors: number;    // 主站独立访客数
  github_requests: number;  // GitHub 加速请求数
  docker_requests: number;  // Docker 加速请求数
  github_bytes: number;
  docker_bytes: number;
}

// SQLite 数据库实例
let sqliteDb: Database.Database | null = null;

// 防刷配置
const ANTI_SPAM_CONFIG = {
  // 同一访客在 X 分钟内只统计一次主站访问
  VISIT_COOLDOWN: 10 * 60 * 1000, // 10 分钟
  
  // 设备指纹缓存（内存）
  visitorCache: new Map<string, { lastVisit: number; count: number }>(),
  
  // 缓存清理间隔
  CACHE_CLEANUP: 30 * 60 * 1000, // 30 分钟
};

// 初始化 SQLite
function getSQLite(): Database.Database | null {
  if (sqliteDb) return sqliteDb;
  
  try {
    // 在 Astro SSR 中，使用 import.meta.env 或硬编码路径
    const cwd = process.cwd?.() || 'unknown';
    console.log('Process CWD:', cwd);
    
    const dbDir = './data';
    const dbPath = './data/stats.db';
    console.log('Database path:', dbPath);
    
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    sqliteDb = new Database(dbPath);
    
    // 创建访问记录表
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        visitor_hash TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT,
        path TEXT,
        first_visit INTEGER,
        last_visit INTEGER,
        visit_count INTEGER DEFAULT 1,
        date TEXT,
        UNIQUE(visitor_hash, date)
      );
      
      CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(date);
      CREATE INDEX IF NOT EXISTS idx_visits_hash ON visits(visitor_hash);
    `);
    
    // 创建每日统计表
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS daily_stats (
        date TEXT PRIMARY KEY,
        main_visits INTEGER DEFAULT 0,
        main_visitors INTEGER DEFAULT 0,
        github_requests INTEGER DEFAULT 0,
        docker_requests INTEGER DEFAULT 0,
        github_bytes INTEGER DEFAULT 0,
        docker_bytes INTEGER DEFAULT 0,
        last_updated INTEGER
      );
    `);
    
    console.log('SQLite database initialized at:', dbPath);
    return sqliteDb;
  } catch (error) {
    console.error('Failed to initialize SQLite:', error);
    return null;
  }
}

// 获取今日日期字符串（本地时区）
function getTodayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 生成访客哈希（IP + User-Agent）
function generateVisitorHash(ip: string, userAgent: string): string {
  const data = `${ip}|${userAgent}`;
  return crypto.createHash('md5').update(data).digest('hex');
}

// 清理过期缓存
function cleanupVisitorCache() {
  const now = Date.now();
  for (const [hash, data] of ANTI_SPAM_CONFIG.visitorCache.entries()) {
    if (now - data.lastVisit > ANTI_SPAM_CONFIG.CACHE_CLEANUP) {
      ANTI_SPAM_CONFIG.visitorCache.delete(hash);
    }
  }
}

// 检查是否应该统计访问（防刷机制）
function shouldCountVisit(visitorHash: string): boolean {
  const now = Date.now();
  const cached = ANTI_SPAM_CONFIG.visitorCache.get(visitorHash);
  
  if (!cached) {
    // 新访客，直接统计
    ANTI_SPAM_CONFIG.visitorCache.set(visitorHash, {
      lastVisit: now,
      count: 1
    });
    return true;
  }
  
  // 检查是否在冷却期内
  if (now - cached.lastVisit < ANTI_SPAM_CONFIG.VISIT_COOLDOWN) {
    // 冷却期内，不统计但更新最后访问时间
    cached.lastVisit = now;
    cached.count++;
    return false;
  }
  
  // 超过冷却期，统计并更新
  cached.lastVisit = now;
  cached.count++;
  return true;
}

// 统计主站访问
export async function trackMainVisit(
  ip: string,
  userAgent: string,
  path: string
): Promise<{ counted: boolean; isNewVisitor: boolean }> {
  console.log('trackMainVisit called:', { ip, path, userAgent: userAgent.substring(0, 50) });
  
  const db = getSQLite();
  if (!db) {
    console.log('No database connection');
    return { counted: false, isNewVisitor: false };
  }
  
  const visitorHash = generateVisitorHash(ip, userAgent);
  const today = getTodayKey();
  const now = Date.now();
  
  console.log('Visitor hash:', visitorHash, 'Today:', today);
  
  // 检查是否应该统计（防刷）
  const shouldCount = shouldCountVisit(visitorHash);
  console.log('Should count visit:', shouldCount);
  
  // 定期清理缓存
  if (Math.random() < 0.01) { // 1% 概率触发清理
    cleanupVisitorCache();
  }
  
  try {
    // 查找今日是否已有记录
    const existing = db.prepare(`
      SELECT * FROM visits 
      WHERE visitor_hash = ? AND date = ?
    `).get(visitorHash, today) as any;
    
    if (existing) {
      // 更新现有记录
      db.prepare(`
        UPDATE visits 
        SET last_visit = ?, visit_count = visit_count + 1, path = ?
        WHERE id = ?
      `).run(now, path, existing.id);
      
      // 如果应该统计，增加主站访问数
      if (shouldCount) {
        incrementDailyStat(today, 'main_visits', 1);
      }
      
      return { counted: shouldCount, isNewVisitor: false };
    } else {
      // 新访客，插入记录
      db.prepare(`
        INSERT INTO visits (visitor_hash, ip, user_agent, path, first_visit, last_visit, visit_count, date)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).run(visitorHash, ip, userAgent, path, now, now, today);
      
      // 增加独立访客数和访问数
      incrementDailyStat(today, 'main_visitors', 1);
      incrementDailyStat(today, 'main_visits', 1);
      
      return { counted: true, isNewVisitor: true };
    }
  } catch (error) {
    console.error('Failed to track visit:', error);
    return { counted: false, isNewVisitor: false };
  }
}

// 统计加速请求
export async function trackProxyRequest(
  service: 'github' | 'docker',
  bytes: number
): Promise<void> {
  const db = getSQLite();
  if (!db) return;
  
  const today = getTodayKey();
  
  try {
    if (service === 'github') {
      incrementDailyStat(today, 'github_requests', 1);
      incrementDailyStat(today, 'github_bytes', bytes);
    } else {
      incrementDailyStat(today, 'docker_requests', 1);
      incrementDailyStat(today, 'docker_bytes', bytes);
    }
  } catch (error) {
    console.error('Failed to track proxy request:', error);
  }
}

// 增加每日统计
function incrementDailyStat(date: string, field: string, value: number) {
  const db = getSQLite();
  if (!db) return;
  
  // 确保记录存在
  db.prepare(`
    INSERT OR IGNORE INTO daily_stats (date, last_updated)
    VALUES (?, ?)
  `).run(date, Date.now());
  
  // 更新字段
  db.prepare(`
    UPDATE daily_stats 
    SET ${field} = ${field} + ?, last_updated = ?
    WHERE date = ?
  `).run(value, Date.now(), date);
}

// 获取统计数据
export async function getStats() {
  const db = getSQLite();
  if (!db) return getDefaultStats();
  
  const today = getTodayKey();
  
  try {
    // 获取今日统计
    const todayStats = db.prepare(`
      SELECT * FROM daily_stats WHERE date = ?
    `).get(today) as any;
    
    // 获取累计统计
    const totalStats = db.prepare(`
      SELECT 
        SUM(main_visits) as main_visits,
        SUM(main_visitors) as main_visitors,
        SUM(github_requests) as github_requests,
        SUM(docker_requests) as docker_requests,
        SUM(github_bytes) as github_bytes,
        SUM(docker_bytes) as docker_bytes
      FROM daily_stats
    `).get() as any;
    
    return {
      today: {
        date: today,
        mainVisits: todayStats?.main_visits || 0,
        mainVisitors: todayStats?.main_visitors || 0,
        githubRequests: todayStats?.github_requests || 0,
        dockerRequests: todayStats?.docker_requests || 0,
        githubBytes: todayStats?.github_bytes || 0,
        dockerBytes: todayStats?.docker_bytes || 0
      },
      total: {
        mainVisits: totalStats?.main_visits || 0,
        mainVisitors: totalStats?.main_visitors || 0,
        githubRequests: totalStats?.github_requests || 0,
        dockerRequests: totalStats?.docker_requests || 0,
        githubBytes: totalStats?.github_bytes || 0,
        dockerBytes: totalStats?.docker_bytes || 0
      }
    };
  } catch (error) {
    console.error('Failed to get stats:', error);
    return getDefaultStats();
  }
}

// 默认统计数据
function getDefaultStats() {
  const today = getTodayKey();
  return {
    today: {
      date: today,
      mainVisits: 0,
      mainVisitors: 0,
      githubRequests: 0,
      dockerRequests: 0,
      githubBytes: 0,
      dockerBytes: 0
    },
    total: {
      mainVisits: 0,
      mainVisitors: 0,
      githubRequests: 0,
      dockerRequests: 0,
      githubBytes: 0,
      dockerBytes: 0
    }
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

