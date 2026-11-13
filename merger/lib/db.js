/* طبقة Turso (libSQL): مخطط + عمليات المهام + تخزين Blobs مقسّمة صفوفًا 2MB مع قراءة تدفقية صفحات */
"use strict";
const { createClient } = require("@libsql/client");
const { HttpError, LIMITS } = require("./util");

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  // متغيرا Turso إلزاميان — رسالة عربية واضحة بدل انهيار صامت
  throw new Error("متغيرا البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزاميان");
}

const client = createClient({ url, authToken: token });
let schemaReady = null;

// إنشاء الجداول عند أول وصول — بلا أداة migrations
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = client.batch(
      [
        `CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'queued',
          progress INTEGER DEFAULT 0,
          error TEXT,
          sources_count INTEGER DEFAULT 0,
          total_duration REAL,
          video_size INTEGER,
          duration REAL,
          resolution TEXT,
          video_mime TEXT DEFAULT 'video/mp4',
          expires_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )`,
        `CREATE TABLE IF NOT EXISTS sources (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          url TEXT,
          name TEXT,
          mime TEXT,
          size INTEGER DEFAULT 0,
          uploaded_bytes INTEGER DEFAULT 0,
          PRIMARY KEY (job_id, seq)
        )`,
        `CREATE TABLE IF NOT EXISTS source_chunks (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          row_index INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, seq, row_index)
        )`,
        `CREATE TABLE IF NOT EXISTS output_chunks (
          job_id TEXT NOT NULL,
          row_index INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, row_index)
        )`,
      ],
      "write"
    );
  }
  return schemaReady;
}

async function dbHealthy() {
  const r = await client.execute("SELECT 1");
  return r.rows.length === 1;
}

// --- تنظيف كسول للمهام المنتهية (تُستدعى عند الإنشاء/الدمج + /api/cron) ---
async function listExpiredJobs(limit = 100) {
  const r = await client.execute({
    sql: `SELECT id FROM jobs WHERE expires_at IS NOT NULL AND expires_at <= datetime('now') LIMIT ?`,
    args: [limit],
  });
  return r.rows.map((x) => x.id);
}

async function deleteJobCascade(id) {
  await client.batch(
    [
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM jobs WHERE id = ?", args: [id] },
    ],
    "write"
  );
}

async function cleanupExpired() {
  const ids = await listExpiredJobs();
  for (const id of ids) await deleteJobCascade(id);
  return ids.length;
}

// --- إنشاء المهام ---
async function createJob(jobId, status, sources, expiresAt) {
  await client.execute({
    sql: `INSERT INTO jobs (id, status, sources_count, expires_at) VALUES (?, ?, ?, ?)`,
    args: [jobId, status, sources.length, expiresAt],
  });
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    await client.execute({
      sql: `INSERT INTO sources (job_id, seq, kind, url, name, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [jobId, i, s.kind, s.url || null, s.name || null, s.mime || null, s.size || 0],
    });
  }
}

async function getJob(id) {
  const r = await client.execute({ sql: `SELECT * FROM jobs WHERE id = ?`, args: [id] });
  if (!r.rows.length) throw new HttpError(404, "مهمة غير موجودة (قد تكون حُذفت أو انتهت صلاحيتها)");
  const j = r.rows[0];
  j.sources = (await client.execute({ sql: `SELECT * FROM sources WHERE job_id = ? ORDER BY seq`, args: [id] })).rows;
  return j;
}

const JOB_COLS = ["status", "progress", "error", "total_duration", "video_size", "duration", "resolution", "video_mime", "expires_at"];

async function updateJob(id, patch) {
  const sets = [];
  const args = [];
  for (const k of JOB_COLS) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      args.push(patch[k]);
    }
  }
  if (!sets.length) return;
  sets.push(`updated_at = datetime('now')`);
  args.push(id);
  await client.execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

function markFailed(id, message) {
  return updateJob(id, { status: "failed", error: message, progress: 100 });
}

// --- رفع أجزاء المصادر: كل جزء ≤4MB يُقسَّم صفوفًا 2MB — الجزء k يشغل الصفوف [k*2, k*2+1] بالضبط
// فإعادة محاولة الجزء نفسه تحذف صفوفه القديمة وتستبدلها (UPSERT آمن بلا تكرار)
async function appendSourceChunk(jobId, seq, buf, chunkIndex = 0) {
  const rowsPerChunk = Math.ceil(LIMITS.uploadChunkBytes / LIMITS.chunkRowBytes); // = 2
  const base = Math.max(0, Math.floor(chunkIndex)) * rowsPerChunk;
  const stmts = [
    {
      sql: `DELETE FROM source_chunks WHERE job_id = ? AND seq = ? AND row_index BETWEEN ? AND ?`,
      args: [jobId, seq, base, base + rowsPerChunk - 1],
    },
  ];
  const rows = Math.ceil(buf.length / LIMITS.chunkRowBytes);
  for (let i = 0; i < rows; i++) {
    stmts.push({
      sql: `INSERT INTO source_chunks (job_id, seq, row_index, data) VALUES (?, ?, ?, ?)`,
      args: [jobId, seq, base + i, buf.subarray(i * LIMITS.chunkRowBytes, (i + 1) * LIMITS.chunkRowBytes)],
    });
  }
  await client.batch(stmts, "write");
  const r = await client.execute({
    sql: `SELECT COALESCE(SUM(LENGTH(data)), 0) AS uploaded FROM source_chunks WHERE job_id = ? AND seq = ?`,
    args: [jobId, seq],
  });
  const uploaded = Number(r.rows[0].uploaded);
  await client.execute({
    sql: `UPDATE sources SET uploaded_bytes = ? WHERE job_id = ? AND seq = ?`,
    args: [uploaded, jobId, seq],
  });
  return uploaded;
}

// قراءة تدفقية لصفوف الـ Blobs — صفحات من 8 صفوف، مع تقليم أول/آخر جزء حسب المدى المطلوب (Range)
async function* iterBlobRows(table, jobId, startByte, endByte) {
  let cursor = 0;          // موضع القراءة الحالي بالبايت داخل الملف المنطقي
  let lastRow = -1;
  const pos = startByte;
  let done = false;
  while (!done) {
    const r = await client.execute({
      sql: `SELECT row_index, data, LENGTH(data) AS len FROM ${table} WHERE job_id = ? AND row_index > ? ORDER BY row_index ASC LIMIT 8`,
      args: [jobId, lastRow],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      lastRow = Number(row.row_index);
      const len = Number(row.len);
      const rowStart = cursor;
      const rowEnd = cursor + len; // حصري
      cursor = rowEnd;
      if (rowEnd <= pos) continue;             // الصف كله قبل بداية المدى
      const from = Math.max(pos, rowStart) - rowStart;
      const to = Math.min(endByte + 1, rowEnd) - rowStart;
      if (to <= from) { done = true; break; }  // تجاوزنا نهاية المدى
      const buf = Buffer.from(row.data);
      yield buf.subarray(from, to);
      if (rowEnd >= endByte + 1) { done = true; break; }
    }
  }
}

async function blobTotalSize(table, jobId) {
  const r = await client.execute({
    sql: `SELECT COALESCE(SUM(LENGTH(data)), 0) AS total, COUNT(*) AS cnt FROM ${table} WHERE job_id = ?`,
    args: [jobId],
  });
  return { total: Number(r.rows[0].total), rows: Number(r.rows[0].cnt) };
}

// --- تخزين الناتج: قراءة الملف النهائي وتحويله صفوف 2MB (دفعة صغيرة لكل طلب HTTP) ---
async function saveOutputChunks(jobId, filePath) {
  const fs = require("fs");
  const fh = await fs.promises.open(filePath, "r");
  try {
    const size = (await fh.stat()).size;
    const rows = Math.ceil(size / LIMITS.chunkRowBytes);
    let ri = 0;
    while (ri < rows) {
      const batchCount = Math.min(2, rows - ri); // صفّان لكل دفعة ≈ 4MB — آمن لحد HTTP في Turso
      const stmts = [];
      for (let k = 0; k < batchCount; k++, ri++) {
        const offset = ri * LIMITS.chunkRowBytes;
        const len = Math.min(LIMITS.chunkRowBytes, size - offset);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        stmts.push({ sql: `INSERT INTO output_chunks (job_id, row_index, data) VALUES (?, ?, ?)`, args: [jobId, ri, buf] });
      }
      await client.batch(stmts, "write");
    }
    return size;
  } finally {
    await fh.close();
  }
}

async function deleteSourceChunks(jobId) {
  await client.execute({ sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [jobId] });
}

module.exports = {
  client,
  ensureSchema,
  dbHealthy,
  createJob,
  getJob,
  updateJob,
  markFailed,
  deleteJobCascade,
  cleanupExpired,
  appendSourceChunk,
  iterBlobRows,
  blobTotalSize,
  saveOutputChunks,
  deleteSourceChunks,
};
