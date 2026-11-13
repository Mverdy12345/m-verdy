/* GET/DELETE /api/jobs/<id> — الحالة والتقدم والرابط عند الاكتمال / حذف فوري شامل */
"use strict";
const { guard, sendJson, sendError, baseUrl, isExpired } = require("../../lib/util");
const db = require("../../lib/db");

module.exports = guard(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  await db.ensureSchema();
  const id = String(req.query.id || "");
  const base = baseUrl(req);

  if (req.method === "DELETE") {
    await db.ensureSchema();
    // تحقق من الوجود أولًا ليرد 404 الصحيح
    const job = await db.getJob(id);
    await db.deleteJobCascade(id);
    return sendJson(res, 200, { ok: true, deleted: job.id });
  }

  if (req.method !== "GET") return sendError(res, 405, "طريقة غير مسموحة — استخدم GET للحالة أو DELETE للحذف");

  const job = await db.getJob(id);
  if (isExpired(job.expires_at) && job.status !== "done") {
    await db.deleteJobCascade(id);
    return sendError(res, 404, "مهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  }

  const done = job.status === "done";
  const resp = {
    jobId: job.id,
    status: done ? "done" : job.status, // أكمل: done|completed|... — نوحّدها إلى done
    progress: Math.max(0, Math.min(100, Number(job.progress) || 0)),
    sources: (job.sources || []).length,
    expiresAt: job.expires_at,
    createdAt: job.created_at,
  };
  if (done) {
    resp.videoUrl = `${base}/api/jobs/${id}/video`;
    resp.downloadUrl = `${base}/api/jobs/${id}/video?download=1`;
    resp.size = Number(job.video_size) || undefined;
    resp.duration = job.duration != null ? Number(job.duration) : undefined;
    resp.resolution = job.resolution || undefined;
  }
  if (job.error) resp.error = job.error;
  return sendJson(res, 200, resp);
});
