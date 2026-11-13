/* POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن): سحب المصادر ← ترميز ← تخزين Blobs ← رابط الناتج */
"use strict";
const path = require("path");
const { guard, sendJson, sendError, HttpError, LIMITS } = require("../../../lib/util");
const db = require("../../../lib/db");
const storage = require("../../../lib/storage");
const merge = require("../../../lib/merge");

module.exports = guard(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method !== "POST") return sendError(res, 405, "طريقة غير مسموحة — استخدم POST لتنفيذ الدمج");

  await db.ensureSchema();
  await db.cleanupExpired();

  const id = String(req.query.id || "");
  const job = await db.getJob(id); // 404 عربي إن لم توجد

  if (job.status === "done") return sendError(res, 409, "المهمة مكتملة مسبقًا — استخدم رابط الناتج من GET /api/jobs/" + id);
  if (job.status === "processing") return sendJson(res, 202, { status: "processing", progress: job.progress || 0 });
  if (job.status === "failed") return sendError(res, 409, `المهمة فشلت سابقًا: ${job.error || "سبب غير معروف"}`);

  const sources = job.sources || [];
  if (sources.length < 2) {
    await db.markFailed(id, "المصادر أقل من مقطعين");
    return sendError(res, 400, "الدمج يحتاج مقطعين على الأقل");
  }

  const tmpFiles = [];
  const srcFiles = []; // ملفات المصادر فقط — الناتج يُستبعد من مدخلات ffmpeg
  const outPath = await storage.tmpFile(id, "out", ".mp4");
  tmpFiles.push(outPath);
  try {
    // 0–40%: سحب المصادر (روابط → تنزيل بحد حجم، ملفات → سحب أجزاء Turso)
    await db.updateJob(id, { status: "processing", progress: 1, error: null });
    const probes = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const f = await storage.tmpFile(id, i);
      tmpFiles.push(f);
      srcFiles.push(f);
      if (s.kind === "url") {
        await storage.downloadToFile(s.url, f);
      } else {
        const total = Number(s.size) || 0;
        if (total > 0 && Number(s.uploaded_bytes) < total) {
          throw new HttpError(409, `الملف رقم ${i + 1} لم يُرفع بالكامل (${s.uploaded_bytes}/${total} بايت)`);
        }
        await storage.writeChunksToFile(id, i, f);
      }
      probes.push(await merge.probeFile(f));
      await db.updateJob(id, { progress: Math.min(39, 3 + Math.round((37 * (i + 1)) / sources.length)) });
    }

    // فحص الحدود قبل الترميز
    const { width, height, totalDuration } = merge.planInputs(probes);
    await db.updateJob(id, { total_duration: totalDuration, progress: 40 });

    // 40–90%: ترميز موحد + دمج (تقدم حقيقي من ffmpeg إلى القاعدة)
    await merge.encode({
      inputs: srcFiles,
      probes,
      outputPath: outPath,
      width,
      height,
      totalDuration,
      onProgress: async (pct) => {
        try { await db.updateJob(id, { progress: 40 + Math.min(50, Math.max(0, Math.round(pct * 0.5))) }); } catch (_) {}
      },
    });

    const fs = require("fs");
    const outSize = (await fs.promises.stat(outPath)).size;
    if (outSize > LIMITS.outputMaxBytes) {
      throw new HttpError(413, `حجم الناتج (${(outSize / 1024 / 1024).toFixed(1)}MB) يتجاوز الحد المسموح (${Math.floor(LIMITS.outputMaxBytes / 1024 / 1024)}MB)`);
    }

    // 90–100%: تخزين الناتج في Turso (صفوف 2MB) ثم حذف أجزاء المصادر — الناتج فقط هو المطلوب
    await db.updateJob(id, { progress: 91 });
    const savedSize = await db.saveOutputChunks(id, outPath);
    await db.deleteSourceChunks(id);
    const finalProbe = probes.reduce(
      (acc, p) => {
        acc.w = Math.max(acc.w, Math.min(p.width, 1920));
        acc.h = Math.max(acc.h, Math.min(p.height, 1080));
        return acc;
      },
      { w: 0, h: 0 }
    );
    const resolution = `${finalProbe.w - (finalProbe.w % 2)}x${finalProbe.h - (finalProbe.h % 2)}`;
    await db.updateJob(id, {
      status: "done",
      progress: 100,
      video_size: savedSize,
      duration: totalDuration,
      resolution,
      error: null,
    });

    const base = require("../../../lib/util").baseUrl(req);
    return sendJson(res, 200, {
      status: "done",
      videoUrl: `${base}/api/jobs/${id}/video`,
      downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
      size: savedSize,
      duration: totalDuration,
      resolution,
      expiresAt: job.expires_at,
    });
  } catch (e) {
    // أي فشل معلن = فشل نهائي واضح برسالة عربية — ليس انهيارًا
    const msg = e instanceof HttpError ? e.message : "فشل الدمج بسبب خطأ داخلي";
    await db.markFailed(id, msg).catch(() => {});
    if (e instanceof HttpError) {
      return sendError(res, e.status, msg);
    }
    throw e;
  } finally {
    await storage.cleanupFiles(tmpFiles); // نظّف /tmp دائمًا
  }
});
