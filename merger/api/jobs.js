/* POST /api/jobs — إنشاء مهمة دمج من روابط مباشرة أو مصادر ملفات (رفع أجزاء) */
"use strict";
const { guard, sendJson, sendError, parseJsonBody, newId, baseUrl, isPublicHttpUrl, expiresAtIso, HttpError, LIMITS } = require("../lib/util");
const db = require("../lib/db");

module.exports = guard(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "POST") return sendError(res, 405, "طريقة غير مسموحة — استخدم POST لإنشاء مهمة");

  await db.ensureSchema();
  await db.cleanupExpired(); // تنظيف كسول للمهام المنتهية

  const body = await parseJsonBody(req);
  let sources = [];
  if (Array.isArray(body.videos)) {
    sources = body.videos.map((u) => ({ kind: "url", url: String(u || "") }));
  } else if (Array.isArray(body.sources)) {
    sources = body.sources.map((s) =>
      s && s.kind === "file"
        ? { kind: "file", name: String(s.name || "file"), size: Number(s.size) || 0, mime: String(s.mime || "video/mp4") }
        : { kind: "url", url: String((s && s.url) || "") }
    );
  } else {
    return sendError(res, 400, 'الجسم يجب أن يكون {"videos":["رابط1","رابط2"]} أو {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}');
  }

  if (sources.length < 2) return sendError(res, 400, "الدمج يحتاج مقطعين على الأقل");
  if (sources.length > LIMITS.maxSources) return sendError(res, 400, `أقصى عدد مقاطع للدمج هو ${LIMITS.maxSources}`);

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.kind === "url") {
      if (!isPublicHttpUrl(s.url)) return sendError(res, 400, `المصدر رقم ${i + 1}: يجب أن يكون رابطًا مباشرًا عامًا (http/https)`);
    } else {
      if (!s.size || s.size <= 0) return sendError(res, 400, `المصدر رقم ${i + 1}: يجب تحديد حجم الملف (size)`);
      if (s.size > LIMITS.sourceMaxBytes) return sendError(res, 413, `المصدر رقم ${i + 1}: حجم الملف يتجاوز الحد المسموح (${Math.floor(LIMITS.sourceMaxBytes / 1024 / 1024)}MB)`);
    }
  }

  const jobId = newId();
  const hasFiles = sources.some((s) => s.kind === "file");
  const status = hasFiles ? "uploading" : "queued";
  const expiresAt = expiresAtIso();
  await db.createJob(jobId, status, sources, expiresAt);

  const base = baseUrl(req);
  const resp = {
    jobId,
    status,
    statusUrl: `${base}/api/jobs/${jobId}`,
    processUrl: `${base}/api/jobs/${jobId}/process`,
    expiresAt,
  };
  // إن وُجدت ملفات يرجع uploads[] برابط رفع لكل مصدر + حجم الجزء المطلوب
  if (hasFiles) {
    resp.uploads = sources.map((s, i) =>
      s.kind === "file"
        ? {
            seq: i,
            name: s.name,
            size: s.size,
            chunks: Math.max(1, Math.ceil(s.size / LIMITS.uploadChunkBytes)),
            uploadChunkBytes: LIMITS.uploadChunkBytes,
            uploadUrl: `${base}/api/upload?job=${jobId}&seq=${i}&chunk=0`,
          }
        : { seq: i, kind: "url", url: s.url }
    );
  }
  return sendJson(res, 201, resp);
});
