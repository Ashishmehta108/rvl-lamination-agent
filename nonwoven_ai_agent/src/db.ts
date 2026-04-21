import Database from "better-sqlite3";
import { config } from "./config";

export interface AlertRecord {
  id?: number;
  timestamp: string;
  tag: string;
  label: string;
  value: number | null;
  unit: string;
  level: string;
  message: string;
  llm_analysis?: string | null;
  email_sent?: number;
  acknowledged?: number;
}

export interface ReadingSnapshot {
  timestamp: string;
  tags: Record<string, { value: number | boolean | null; label: string; unit: string }>;
}

const db = new Database(config.DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS readings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL,
        tag_name    TEXT NOT NULL,
        value       REAL,
        unit        TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(timestamp);
    CREATE INDEX IF NOT EXISTS idx_readings_tag ON readings(tag_name, timestamp);

    CREATE TABLE IF NOT EXISTS alerts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL,
        tag         TEXT NOT NULL,
        label       TEXT,
        value       REAL,
        unit        TEXT,
        level       TEXT NOT NULL,
        message     TEXT NOT NULL,
        llm_analysis TEXT,
        email_sent  INTEGER DEFAULT 0,
        acknowledged INTEGER DEFAULT 0,
        created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(timestamp);
    CREATE INDEX IF NOT EXISTS idx_alerts_level ON alerts(level);

    CREATE TABLE IF NOT EXISTS daily_summaries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        date        TEXT NOT NULL UNIQUE,
        stats_json  TEXT NOT NULL,
        total_production_meters REAL DEFAULT 0,
        uptime_minutes INTEGER DEFAULT 0,
        total_alerts INTEGER DEFAULT 0,
        insights    TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS monthly_reports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        year        INTEGER NOT NULL,
        month       INTEGER NOT NULL,
        report_html TEXT NOT NULL,
        metrics_json TEXT,
        email_sent  INTEGER DEFAULT 0,
        created_at  TEXT DEFAULT (datetime('now')),
        UNIQUE(year, month)
    );
  `);
  console.log("[DB] Database initialized successfully.");
}

// ── Readings ─────────────────────────────────────────────────────

export function storeReading(snapshot: ReadingSnapshot) {
  const timestamp = snapshot.timestamp || new Date().toISOString();
  const insert = db.prepare("INSERT INTO readings (timestamp, tag_name, value, unit) VALUES (?, ?, ?, ?)");
  
  const tags = snapshot.tags || {};
  
  const executeTransaction = db.transaction((tagsRecord: typeof tags) => {
    for (const [tagName, tagData] of Object.entries(tagsRecord)) {
      const val = tagData.value;
      if (val !== null && typeof val !== "boolean") {
        insert.run(timestamp, tagName, val, tagData.unit || "");
      } else if (typeof val === "boolean") {
        insert.run(timestamp, tagName, val ? 1.0 : 0.0, "");
      }
    }
  });

  executeTransaction(tags);
}

export function getRecentReadings(tagName: string, hours: number = 1): Array<{timestamp: string, value: number, unit: string}> {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const stmt = db.prepare(`SELECT timestamp, value, unit FROM readings WHERE tag_name = ? AND timestamp > ? ORDER BY timestamp`);
  return stmt.all(tagName, cutoff) as any[];
}

// ── Alerts ───────────────────────────────────────────────────────

export function storeAlert(alert: AlertRecord): number {
  const stmt = db.prepare(
    `INSERT INTO alerts (timestamp, tag, label, value, unit, level, message) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    alert.timestamp || new Date().toISOString(),
    alert.tag || "",
    alert.label || "",
    alert.value,
    alert.unit || "",
    alert.level || "WARNING",
    alert.message || ""
  );
  return info.lastInsertRowid as number;
}

export function updateAlertLlmAnalysis(alertId: number, analysis: string) {
  const stmt = db.prepare("UPDATE alerts SET llm_analysis = ? WHERE id = ?");
  stmt.run(analysis, alertId);
}

export function getAlertsSince(hours: number = 24): AlertRecord[] {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const stmt = db.prepare("SELECT * FROM alerts WHERE timestamp > ? ORDER BY timestamp DESC");
  return stmt.all(cutoff) as AlertRecord[];
}

export function getRecentAlerts(limit: number = 500): AlertRecord[] {
  const stmt = db.prepare("SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?");
  return stmt.all(limit) as AlertRecord[];
}

// ── Daily Summaries ──────────────────────────────────────────────

export function getDailyStats(dateStr?: string): Record<string, any> {
  if (!dateStr) {
    dateStr = new Date().toISOString().split("T")[0];
  }
  const stmt = db.prepare(`
    SELECT tag_name, 
           MIN(value) as min_val, MAX(value) as max_val, 
           AVG(value) as avg_val, COUNT(*) as sample_count 
    FROM readings 
    WHERE DATE(timestamp) = ? 
    GROUP BY tag_name
  `);
  const rows = stmt.all(dateStr) as any[];
  
  const stats: Record<string, any> = {};
  for (const r of rows) {
    stats[r.tag_name] = {
      min: r.min_val !== null ? Number(r.min_val.toFixed(3)) : null,
      max: r.max_val !== null ? Number(r.max_val.toFixed(3)) : null,
      avg: r.avg_val !== null ? Number(r.avg_val.toFixed(3)) : null,
      samples: r.sample_count
    };
  }
  return stats;
}

export function storeDailySummary(dateStr: string, stats: any, prodMeters: number, uptimeMin: number, alerts: number, insights: string | null) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO daily_summaries 
    (date, stats_json, total_production_meters, uptime_minutes, total_alerts, insights) 
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(dateStr, JSON.stringify(stats), prodMeters, uptimeMin, alerts, insights);
}

// ── Monthly Reports ──────────────────────────────────────────────

export function getMonthlySummary(year: number, month: number): any {
  // SQLite format: YYYY-MM-DD
  const startStr = `${year}-${month.toString().padStart(2, "0")}-01`;
  let endY = year;
  let endM = month + 1;
  if (endM > 12) {
    endY++;
    endM = 1;
  }
  const endStr = `${endY}-${endM.toString().padStart(2, "0")}-01`;

  const tagRows = db.prepare(`
    SELECT tag_name, MIN(value) as min_val, MAX(value) as max_val, AVG(value) as avg_val, COUNT(*) as sample_count 
    FROM readings WHERE DATE(timestamp) >= ? AND DATE(timestamp) < ? GROUP BY tag_name
  `).all(startStr, endStr) as any[];

  const alertRows = db.prepare(`
    SELECT level, COUNT(*) as cnt FROM alerts WHERE DATE(timestamp) >= ? AND DATE(timestamp) < ? GROUP BY level
  `).all(startStr, endStr) as any[];

  const prodRow = db.prepare(`
    SELECT MIN(value) as start_m, MAX(value) as end_m FROM readings 
    WHERE tag_name = 'TOTAL_METER' AND DATE(timestamp) >= ? AND DATE(timestamp) < ?
  `).get(startStr, endStr) as any;

  const dailyRows = db.prepare(`
    SELECT * FROM daily_summaries WHERE date >= ? AND date < ? ORDER BY date
  `).all(startStr, endStr) as any[];

  const tagStats: Record<string, any> = {};
  for (const r of tagRows) {
    tagStats[r.tag_name] = {
      min: r.min_val !== null ? Number(r.min_val.toFixed(3)) : null,
      max: r.max_val !== null ? Number(r.max_val.toFixed(3)) : null,
      avg: r.avg_val !== null ? Number(r.avg_val.toFixed(3)) : null,
      samples: r.sample_count
    };
  }

  const alertCounts: Record<string, number> = {};
  let totalAlerts = 0;
  for (const r of alertRows) {
    alertCounts[r.level] = r.cnt;
    totalAlerts += r.cnt;
  }

  let productionMeters = 0;
  if (prodRow && prodRow.start_m !== null && prodRow.end_m !== null) {
    productionMeters = Number((prodRow.end_m - prodRow.start_m).toFixed(1));
  }

  return {
    year,
    month,
    tagStats,
    alertCounts,
    totalAlerts,
    productionMeters,
    dailySummaries: dailyRows,
    operatingDays: dailyRows.length
  };
}

export function storeMonthlyReport(year: number, month: number, reportHtml: string, metrics: any) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO monthly_reports (year, month, report_html, metrics_json) 
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(year, month, reportHtml, JSON.stringify(metrics));
}

export function getMonthlyReports(): any[] {
  return db.prepare(`SELECT id, year, month, email_sent, created_at FROM monthly_reports ORDER BY year DESC, month DESC`).all();
}

export function getMonthlyReport(id: number): any {
  return db.prepare(`SELECT * FROM monthly_reports WHERE id = ?`).get(id);
}

// ── Cleanup ──────────────────────────────────────────────────────

export function cleanupOldReadings(days: number = 90) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM readings WHERE timestamp < ?`).run(cutoff);
  console.log(`[DB] Cleaned up readings older than ${days} days.`);
}
