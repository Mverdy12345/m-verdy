/* POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء ملفات ثنائية ≤4MB مع إعادة محاولة آمنة (UPSERT) */
"use strict";
const { guard, sendJson, sendError, readBody, HttpError, LIMITS } = require("../lib/util");
const db = require("../lib/db");

module.exports = guard(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "POST") return sendError(res, 405, "طريقة غير مسموحة — استخدم POST لرفع الأجزاء");

  await db.ensureSchema();

  const jobId = String(req.query.job || "");
  const seq = Number(req.query.seq);
  const chunk = Number(req.query.chunk);
  if (!jobId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunk) || chunk < 0) {
    return sendError(res, 400, "معاملات الرفع غير صالحة — المطلوب job و seq و chunk");
  }

  const job = await db.getJob(jobId); // يرمي 404 برسالة عربية إن لم توجد
  if (job.status === "done" || job.status === "processing" || job.status === "failed") {
    return sendError(res, 409, "المهمة قيد المعالجة أو منتهية بالفعل — لا يمكن رفع أجزاء جديدة");
  }
  if (!job.sources || !job.sources[seq]) return sendError(res, 404, "المصدر المطلوب غير موجود في هذه المهمة");
  if (job.sources[seq].kind !== "file") return sendError(res, 409, "هذا المصدر رابط مباشر — لا يحتاج رفع أجزاء");
  if (isExpiredCheck(job.expires_at)) return sendError(res, 404, "انتهت صلاحية المهمة (24 ساعة)");

  // الجزء ≤ 4MB — تجاوزه يرفض 413 (حد حجم الطلب في Vercel ≈ 4.5MB)
  const buf = await readBody(req, LIMITS.uploadChunkBytes);
  if (!buf.length) return sendError(res, 400, "جسم الطلب فارغ — يجب إرسال البيانات الثنائية بصيغة application/octet-stream");
  if (Number.isInteger(chunk) && chunk > Math.ceil((job.sources[seq].size || 0) / LIMITS.uploadChunkBytes)) {
    return sendError(res, 400, "رقم الجزء يتجاوز عدد أجزاء الملف المتوقع");
  }

  const uploaded = await db.appendSourceChunk(jobId, seq, buf, chunk);
  const total = Number(job.sources[seq].size) || 0;
  return sendJson(res, 200, {
    ok: true,
    job: jobId,
    seq,
    chunk,
    received: buf.length,
    uploadedBytes: uploaded,
    totalBytes: total,
    done: total > 0 ? uploaded >= total : uploaded > 0,
  });
});

function isExpiredCheck(expiresAt) {
  if (!expiresAt) return false;
  const t = Date.parse(String(expiresAt).replace(" ", "T") + (String(expiresAt).includes("Z") ? "" : "Z"));
  return Number.isFinite(t) && Date.now() >= t;
}
