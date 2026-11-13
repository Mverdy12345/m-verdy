/* GET /api/jobs/<id>/video — بث الناتج بدعم Range (206 + Content-Range) و ?download=1 للتحميل */
"use strict";
const { guard, sendError, parseRange, CORS_HEADERS, HttpError, LIMITS } = require("../../../lib/util");
const db = require("../../../lib/db");

module.exports = guard(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson204(res);
  if (req.method !== "GET" && req.method !== "HEAD") return sendError(res, 405, "طريقة غير مسموحة — استخدم GET لبث الفيديو");

  await db.ensureSchema();
  const id = String(req.query.id || "");
  const job = await db.getJob(id);
  if (job.status !== "done") return sendError(res, 404, "الناتج غير جاهز بعد — المهمة بحالة " + job.status);

  const { total } = await db.blobTotalSize("output_chunks", id);
  if (!total) return sendError(res, 404, "بيانات الفيديو الناتج غير موجودة (حُذفت أو انتهت صلاحيتها)");

  const range = parseRange(req.headers.range, total);
  let start = 0;
  let end = total - 1;
  let partial = false;
  if (range) {
    if (range.invalid && range.unsatisfiable) {
      res.writeHead(416, { "Content-Range": `bytes */${total}`, ...CORS_HEADERS });
      return res.end();
    }
    if (range.invalid) return sendError(res, 400, "ترويسة Range غير صالحة");
    start = range.start;
    end = range.end;
    partial = true;
  }
  const length = end - start + 1;

  const download = req.query.download === "1" || req.query.download === "true";
  const headers = {
    "Content-Type": job.video_mime || "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="merged-${id}.mp4"`,
    ...CORS_HEADERS,
  };
  if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
  headers["Content-Length"] = String(length);
  res.writeHead(partial ? 206 : 200, headers);

  if (req.method === "HEAD") return res.end();

  // تحويل صفوف الـ Blobs إلى تدفق مع تقليم أول/آخر جزء حسب المدى المطلوب
  try {
    for await (const chunk of db.iterBlobRows("output_chunks", id, start, end)) {
      if (!res.write(chunk)) {
        await new Promise((ok) => res.once("drain", ok));
      }
    }
    res.end();
  } catch (e) {
    // انقطاع العميل أثناء البث أمر طبيعي — نتجاهل ما بعد إغلاق الاتصال
    if (!res.writableEnded) { try { res.end(); } catch (_) {} }
  }
});

function sendJson204(res) {
  res.writeHead(204, CORS_HEADERS);
  res.end();
}
