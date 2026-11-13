/* اختبار وحدات: توليد فيديوهين مختلفي الدقة بـ ffmpeg → دمج → تحقق من الدقة/المدة/الصوت + Turso Blobs + الحدود + الحذف */
"use strict";
require("../lib/util"); // تحميل .env يدويًا أولًا
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const util = require("../lib/util");
const merge = require("../lib/merge");
const storage = require("../lib/storage");
const db = require("../lib/db");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✔ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✘ ${name}${extra ? " — " + extra : ""}`); }
}
function gen(f, args) {
  return new Promise(async (resolve, reject) => {
    const bin = await merge.ffmpegPath();
    execFile(bin, ["-y", ...args, f], (e) => (e ? reject(e) : resolve()));
  });
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

(async () => {
  console.log("\n=== اختبار وحدات — محرك الدمج والتخزين ===");
  if (!process.env.TURSO_DATABASE_URL) {
    console.error("متغيرا Turso غير مضبوطين — انسخ .env.example إلى .env أولًا"); process.exit(1);
  }
  await db.ensureSchema();
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mverdy-test-"));

  // 1) توليد فيديوهين مختلفي الدقة — الأول بصوت والثاني صامت (لاختبار anullsrc)
  const c1 = path.join(TMP, "c1.mp4"); // 640x360 مع صوت
  const c2 = path.join(TMP, "c2.mp4"); // 320x240 صامت
  await gen(c1, ["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p"]);
  await gen(c2, ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]);
  ok("توليد مقطعين مختلفي الدقة", fs.existsSync(c1) && fs.existsSync(c2));

  // 2) ffprobe
  const p1 = await merge.probeFile(c1);
  const p2 = await merge.probeFile(c2);
  ok("ffprobe: أبعاد أول مقطع", p1.width === 640 && p1.height === 360, `640x360`);
  ok("ffprobe: وجود صوت في الأول وبغيابه في الثاني", p1.hasAudio === true && p2.hasAudio === false);

  // 3) التخطيط: أكبر دقة = 640x360
  const plan = merge.planInputs([p1, p2]);
  ok("أكبر دقة بين المدخلات", plan.width === 640 && plan.height === 360, `${plan.width}x${plan.height}`);

  // 4) الدمج الكامل
  const out = path.join(TMP, "out.mp4");
  let progressSeen = 0;
  await merge.encode({ inputs: [c1, c2], probes: [p1, p2], outputPath: out, width: plan.width, height: plan.height, totalDuration: plan.totalDuration, onProgress: (p) => (progressSeen = Math.max(progressSeen, p)) });
  ok("اكتمال الدمج", fs.existsSync(out) && fs.statSync(out).size > 10000, fmtBytes(fs.statSync(out).size));
  ok("قراءة تقدم الترميز من -progress", progressSeen >= 0.5, `${Math.round(progressSeen * 100)}%`);

  const outProbe = await merge.probeFile(out);
  ok("دقة الناتج = أكبر دقة مدخل", outProbe.width === 640 && outProbe.height === 360, `${outProbe.width}x${outProbe.height}`);
  ok("مدة الناتج ≈ مجموع المدد", Math.abs(outProbe.duration - (p1.duration + p2.duration)) < 1.5, `${outProbe.duration.toFixed(1)}s ≈ ${(p1.duration + p2.duration).toFixed(1)}s`);
  ok("وجود مسار صوت في الناتج (مضاف تلقائيًا للمقطع الصامت)", outProbe.hasAudio === true);

  // 5) تخزين الناتج في Turso والاسترجاع بتطابق sha256
  const jobId = "ut" + util.newId();
  await db.createJob(jobId, "queued", [{ kind: "url", url: "" }, { kind: "url", url: "" }], util.expiresAtIso());
  const savedSize = await db.saveOutputChunks(jobId, out);
  ok("تخزين الناتج كصفوف 2MB", savedSize === fs.statSync(out).size, `${savedSize} بايت`);
  const back = path.join(TMP, "back.mp4");
  const fh = fs.createWriteStream(back);
  let total = 0;
  for await (const chunk of db.iterBlobRows("output_chunks", jobId, 0, savedSize - 1)) { total += chunk.length; fh.write(chunk); }
  await new Promise((r) => fh.end(r));
  ok("استرجاع Blobs من Turso بتطابق sha256", sha256(back) === sha256(out) && total === savedSize, `sha256 متطابق (${total} بايت)`);

  // 6) مسار رفع الأجزاء كما في البروتوكول الحقيقي: جزء 4MB (chunk=0) + جزء 512KB (chunk=1)
  const upJob = "ut" + util.newId();
  const big = crypto.randomBytes(4 * 1024 * 1024);
  const part2 = crypto.randomBytes(512 * 1024);
  const fullHash = crypto.createHash("sha256").update(Buffer.concat([big, part2])).digest("hex");
  await db.createJob(upJob, "uploading", [{ kind: "file", name: "big.bin", size: big.length + part2.length }], util.expiresAtIso());
  const uploadedA = await db.appendSourceChunk(upJob, 0, big, 0);
  const uploaded = await db.appendSourceChunk(upJob, 0, part2, 1);
  ok("uploaded_bytes = مجموع الأجزاء المرفوعة", uploaded === big.length + part2.length, `${uploaded} بايت`);
  const back2 = path.join(TMP, "back2.bin");
  await storage.writeChunksToFile(upJob, 0, back2);
  ok("استرجاع الأجزاء المرفوعة بتطابق sha256", sha256(back2) === fullHash);

  // 7) إعادة رفع نفس الجزء (إعادة محاولة) تستبدل صفوفه — لا تكرار ولا بقايا
  const uploaded2 = await db.appendSourceChunk(upJob, 0, big, 0);
  const { rows: rowsCount } = await db.blobTotalSize("source_chunks", upJob);
  ok("إعادة محاولة الجزء تستبدل صفوفه بلا تكرار", uploaded2 === uploaded && rowsCount === 3, `${uploaded2} بايت / ${rowsCount} صفوف`);

  // 8) حدود المدة الإجمالية
  let threw = false;
  try { merge.planInputs([{ ...p1, duration: 500 }, { ...p2, duration: 500 }]); } catch (_) { threw = true; }
  ok("رفض تجاوز الحد الإجمالي للمدة (600 ثانية)", threw);

  // 9) حذف شامل يتخلص من كل الصفوف
  await db.deleteJobCascade(jobId);
  await db.deleteJobCascade(upJob);
  const { total: t1 } = await db.blobTotalSize("output_chunks", jobId);
  const { total: t2 } = await db.blobTotalSize("source_chunks", upJob);
  ok("الحذف الشامل يفرغ كل الجداول", t1 === 0 && t2 === 0);

  // 10) الحذف التلقائي للمهام المنتهية
  await db.createJob("ut-expired", "queued", [{ kind: "url", url: "" }, { kind: "url", url: "" }], "2000-01-01 00:00:00");
  const deletedCount = await db.cleanupExpired();
  ok("التنظيف التلقائي يحذف المهام المنتهية", deletedCount >= 1, `${deletedCount} مهمة`);

  await storage.cleanupFiles([c1, c2, out, back, back2]);
  await fs.promises.rm(TMP, { recursive: true, force: true });

  console.log(`\n=== النتيجة: ${passed} ناجح، ${failed} فاشل ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("خطأ فادح:", e); process.exit(1); });

function fmtBytes(n) { const u = ["B", "KB", "MB", "GB"]; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + " " + u[i]; }
