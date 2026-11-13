/* اختبار HTTP كامل ضد خادم التطوير: روابط → دمج → Range 206 → مهمة مختلطة → حذف → 404 → JSON تالف → حدود */
"use strict";
require("../lib/util"); // تحميل .env يدويًا أولًا
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const PORT = 3011;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✔ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✘ ${name}${extra ? " — " + extra : ""}`); }
}
async function j(method, p, body, headers) {
  const r = await fetch(BASE + p, {
    method,
    headers: headers || (body && body instanceof Buffer ? { "Content-Type": "application/octet-stream" } : body ? { "Content-Type": "application/json" } : {}),
    body: body ? (body instanceof Buffer ? body : JSON.stringify(body)) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text, headers: r.headers };
}

(async () => {
  console.log("\n=== اختبار HTTP كامل ضد خادم التطوير ===");
  // تشغيل خادم التطوير
  const server = spawn("node", [path.join(__dirname, "..", "dev-server.js")], { env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
  server.stdout.on("data", (d) => process.stdout.write("  [server] " + d));
  server.stderr.on("data", (d) => process.stderr.write("  [server!] " + d));
  // انتظار الجهوزية
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const c = await j("GET", "/api/config"); up = c.status === 200; } catch (_) {}
  }
  if (!up) { console.error("خادم التطوير لم يجهز"); server.kill(); process.exit(1); }

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mverdy-http-"));
  try {
    // 1) config
    const cfg = await j("GET", "/api/config");
    ok("GET /api/config يرجع الحدود", cfg.status === 200 && cfg.json.limits.maxSources === 10);

    // 2) إنشاء مهمة من روابط عامة ثم الدمج
    const URLs = [
      "https://www.w3schools.com/html/mov_bbb.mp4",
      "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
    ];
    let r = await j("POST", "/api/jobs", { videos: URLs });
    ok("إنشاء مهمة من روابط → 201 مع statusUrl/processUrl", r.status === 201 && r.json.jobId && !!r.json.statusUrl && !!r.json.processUrl && !!r.json.expiresAt, r.json.jobId);
    const job1 = r.json.jobId;

    r = await j("POST", `/api/jobs/${job1}/process`);
    ok("تنفيذ الدمج → done مع روابط", r.status === 200 && r.json.status === "done" && !!r.json.videoUrl && !!r.json.downloadUrl && r.json.size > 0 && !!r.json.resolution, `${r.json && r.json.resolution}`);
    const doneMeta = r.json;

    // 3) بث الناتج مع Range → 206 + Content-Range
    const half = Math.floor(doneMeta.size / 2);
    const rng = await fetch(`${BASE}/api/jobs/${job1}/video`, { headers: { Range: `bytes=${half}-${half + 999}` } });
    const buf = Buffer.from(await rng.arrayBuffer());
    ok("بث الناتج بدعم Range → 206", rng.status === 206 && buf.length === 1000, `Content-Range: ${rng.headers.get("content-range")}`);
    const cr = rng.headers.get("content-range");
    ok("Content-Range صحيح", cr === `bytes ${half}-${half + 999}/${doneMeta.size}`);

    // 4) البث الكامل 200 وطوله مطابق
    const full = await fetch(`${BASE}/api/jobs/${job1}/video`);
    const fullBuf = Buffer.from(await full.arrayBuffer());
    ok("البث الكامل → 200 بطول مطابق", full.status === 200 && fullBuf.length === doneMeta.size);

    // 5) مهمة مختلطة (رابط + ملف مرفوع بأجزاء)
    const local = path.join(TMP, "local.mp4");
    await new Promise(async (resolve, reject) => {
      const { execFile } = require("child_process");
      const merge = require("../lib/merge");
      execFile(await merge.ffmpegPath(), ["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", local], (e) => (e ? reject(e) : resolve()));
    });
    const fbuf = fs.readFileSync(local);
    r = await j("POST", "/api/jobs", { sources: [{ kind: "url", url: URLs[0] }, { kind: "file", name: "local.mp4", size: fbuf.length, mime: "video/mp4" }] });
    ok("إنشاء مهمة مختلطة → 201 حالة uploading مع uploads[]", r.status === 201 && r.json.status === "uploading" && Array.isArray(r.json.uploads));
    const job2 = r.json.jobId;
    const up = r.json.uploads.find((u) => u.uploadUrl);
    ok("uploads[] يحتوي رابط رفع وحجم جزء", !!up && up.uploadChunkBytes === 4 * 1024 * 1024);
    // رفع جزأين (الملف أصغر من 4MB — نقسم من المنتصف)
    const mid = Math.ceil(fbuf.length / 2);
    await j("POST", `/api/upload?job=${job2}&seq=1&chunk=0`, fbuf.subarray(0, mid));
    r = await j("POST", `/api/upload?job=${job2}&seq=1&chunk=1`, fbuf.subarray(mid));
    ok("رفع الأجزاء → done=true بعد اكتمال الحجم", r.status === 200 && r.json.done === true && r.json.uploadedBytes === fbuf.length, `${r.json && r.json.uploadedBytes} بايت`);
    r = await j("POST", `/api/jobs/${job2}/process`);
    ok("دمج مهمة مختلطة (رابط + ملف مرفوع) → done", r.status === 200 && r.json.status === "done", `${r.json && r.json.duration && r.json.duration.toFixed && r.json.duration.toFixed(1)}s`);

    // 6) الحذف ثم 404
    r = await j("DELETE", `/api/jobs/${job1}`);
    ok("DELETE يحذف المهمة", r.status === 200 && r.json.ok === true);
    r = await j("GET", `/api/jobs/${job1}`);
    ok("GET بعد الحذف → 404 برسالة عربية", r.status === 404 && /غير موجودة/.test(r.text));
    r = await j("GET", `/api/jobs/${job1}/video`);
    ok("بث مهمة محذوفة → 404", r.status === 404);

    // 7) JSON تالف → 400
    const bad = await fetch(`${BASE}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{invalid json" });
    ok("JSON تالف → 400", bad.status === 400, (await bad.json()).error);

    // 8) قائمة فارغة/مقطع واحد → 400، أكثر من 10 → 400
    r = await j("POST", "/api/jobs", { videos: [URLs[0]] });
    ok("مقطع واحد → رفض برسالة عربية", r.status === 400 && /مقطعين/.test(r.text));
    r = await j("POST", "/api/jobs", { videos: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`) });
    ok("11 مقطعًا → رفض برسالة عربية", r.status === 400 && /10/.test(r.text));
    r = await j("POST", "/api/jobs", { videos: ["http://localhost/x.mp4", URLs[0]] });
    ok("رابط داخلي (localhost) → رفض", r.status === 400 && /مباشرًا عامًا/.test(r.text));

    // 9) مهمة غير موجودة → 404، حالة غير مناسبة → 409
    r = await j("POST", `/api/jobs/doesnotexist/process`);
    ok("process لمهمة غير موجودة → 404", r.status === 404);
    r = await j("POST", `/api/jobs/${job2}/process`);
    ok("إعادة process لمهمة مكتملة → 409", r.status === 409);

    // 10) تنظيف نهائي
    await j("DELETE", `/api/jobs/${job2}`);
    ok("تنظيف مهمة الاختبار الثانية", true);
  } finally {
    server.kill();
    await fs.promises.rm(TMP, { recursive: true, force: true });
  }
  console.log(`\n=== النتيجة: ${passed} ناجح، ${failed} فاشل ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("خطأ فادح:", e); process.exit(1); });
