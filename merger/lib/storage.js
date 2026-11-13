/* تخزين المصادر: تنزيل الروابط إلى /tmp بحد حجم صارم، وسحب الأجزاء المرفوعة من Turso إلى ملف */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Readable } = require("stream");
const { HttpError, LIMITS, isPublicHttpUrl } = require("./util");
const db = require("./db");

const TMP_DIR = path.join(os.tmpdir(), "m-verdy-merger");

async function tmpFile(jobId, seq, ext = ".bin") {
  await fs.promises.mkdir(TMP_DIR, { recursive: true });
  return path.join(TMP_DIR, `${jobId}-${seq}${ext}`);
}

// تنزيل رابط فيديو مباشر إلى /tmp مع عدّاد بايتات وحد حجم — تجاوز الحد = فشل واضح
async function downloadToFile(url, filePath, maxBytes = LIMITS.sourceMaxBytes) {
  if (!isPublicHttpUrl(url)) throw new HttpError(400, "الرابط يجب أن يكون رابطًا مباشرًا عامًا (http/https)");
  let res;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(90_000) });
  } catch (e) {
    throw new HttpError(500, `فشل تنزيل المصدر: تعذر الوصول إلى الرابط`);
  }
  if (!res.ok) throw new HttpError(500, `فشل تنزيل المصدر (HTTP ${res.status})`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) {
    throw new HttpError(413, `حجم المصدر (${(declared / 1024 / 1024).toFixed(1)}MB) يتجاوز الحد المسموح (${Math.floor(maxBytes / 1024 / 1024)}MB)`);
  }
  const out = fs.createWriteStream(filePath);
  let bytes = 0;
  const stream = Readable.fromWeb(res.body);
  // عدّاد بايتات كـ Transform مع pipeline (يعالج backpressure تلقائيًا)
  const { Transform } = require("stream");
  const counter = new Transform({
    transform(chunk, enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) return cb(new HttpError(413, `حجم المصدر يتجاوز الحد المسموح (${Math.floor(maxBytes / 1024 / 1024)}MB)`));
      cb(null, chunk);
    },
  });
  const { pipeline } = require("stream/promises");
  try {
    await pipeline(stream, counter, out);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, "فشل تنزيل المصدر (انقطاع أثناء النقل)");
  }
  return bytes;
}

// سحب أجزاء ملف مرفوع من Turso (صفوف 2MB) إلى ملف واحد في /tmp
async function writeChunksToFile(jobId, seq, filePath) {
  const out = fs.createWriteStream(filePath);
  let lastRow = -1;
  for (;;) {
    const r = await db.client.execute({
      sql: `SELECT row_index, data FROM source_chunks WHERE job_id = ? AND seq = ? AND row_index > ? ORDER BY row_index ASC LIMIT 8`,
      args: [jobId, seq, lastRow],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      lastRow = Number(row.row_index);
      if (!out.write(Buffer.from(row.data))) await new Promise((ok) => out.once("drain", ok));
    }
  }
  await new Promise((ok, bad) => { out.end(ok); out.on("error", bad); });
  return (await fs.promises.stat(filePath)).size;
}

// تنظيف ملفات /tmp في finally — لا نظام ملفات دائم أبدًا
async function cleanupFiles(files) {
  await Promise.allSettled(files.map((f) => fs.promises.rm(f, { force: true })));
}

module.exports = { tmpFile, TMP_DIR, downloadToFile, writeChunksToFile, cleanupFiles };
