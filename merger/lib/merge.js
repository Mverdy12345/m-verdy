/* محرك الدمج: ffprobe لكل مصدر + توحيد عبر filter_complex + ترميز libx264 CRF18 مع قراءة التقدم */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const { HttpError, LIMITS } = require("./util");

// ثنائيات ffmpeg قد تفقد صلاحية التنفيذ في الاستضافة — ننسخها إلى /tmp بصلاحية 755 عند الحاجة
async function ensureExecutable(binPath, name) {
  try {
    await fs.promises.access(binPath, fs.constants.X_OK);
    return binPath;
  } catch (_) {
    const dst = path.join("/tmp", `${name}-bin-${path.basename(binPath)}`);
    await fs.promises.copyFile(binPath, dst);
    await fs.promises.chmod(dst, 0o755);
    return dst;
  }
}

async function ffmpegPath() { return ensureExecutable(ffmpegStatic, "ffmpeg"); }
async function ffprobePath() { return ensureExecutable(ffprobeStatic.path, "ffprobe"); }

function runBin(bin, args, timeoutMs = 280_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HttpError(500, "تجاوزت العملية المهلة الزمنية المسموحة"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString().slice(-4000)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new HttpError(500, `فشل تنفيذ ${path.basename(bin)} (رمز ${code}): ${err.slice(-400)}`));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new HttpError(500, `تعذر تشغيل ${path.basename(bin)}: ${e.message}`));
    });
  });
}

// ffprobe لكل مصدر: الدقة، معدل الإطارات، المدة، وجود صوت
async function probeFile(file) {
  const bin = await ffprobePath();
  const { out } = await runBin(bin, ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file]);
  let info;
  try { info = JSON.parse(out); } catch (_) { throw new HttpError(500, "تعذر تحليل بيانات المصدر (ffprobe)"); }
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new HttpError(400, "أحد المصادر لا يحتوي مسار فيديو صالحًا — لا يمكن دمجه");
  const duration = Number(v.duration || (info.format && info.format.duration) || 0);
  let fps = 30;
  if (v.r_frame_rate && /^\d+\/\d+$/.test(v.r_frame_rate)) {
    const [n, d] = v.r_frame_rate.split("/").map(Number);
    if (d > 0) fps = n / d;
  }
  return {
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    hasAudio: !!a,
  };
}

// بناء خطة الدمج: أكبر دقة بين المدخلات (حد 1920×1080، أبعاد زوجية)، fps=30، yuv420p، صوت موحد 44100Hz
function planInputs(probes) {
  let W = 0, H = 0;
  for (const p of probes) { W = Math.max(W, p.width); H = Math.max(H, p.height); }
  if (!W || !H) throw new HttpError(400, "تعذر تحديد أبعاد المصادر");
  W = Math.min(W, 1920); H = Math.min(H, 1080);
  W -= W % 2; H -= H % 2; // أبعاد زوجية إلزامية لـ yuv420p
  const totalDuration = probes.reduce((s, p) => s + (p.duration || 0), 0);
  if (totalDuration > LIMITS.maxTotalDurationSec) {
    throw new HttpError(400, `مجموع مدد المقاطع (${totalDuration.toFixed(1)} ثانية) يتجاوز الحد المسموح (${LIMITS.maxTotalDurationSec} ثانية)`);
  }
  return { width: W, height: H, totalDuration };
}

// الدمج الكامل: inputs ملفات /tmp وprobes نتائج ffprobe — مصدر بلا صوت يحصل على مدخل anullsrc بنفس مدته
async function encode({ inputs, probes, outputPath, width, height, totalDuration, onProgress }) {
  const bin = await ffmpegPath();
  const silentIndexes = []; // فهارس المصادر التي لا تحتوي صوتًا
  (probes || []).forEach((p, i) => { if (p && p.hasAudio === false) silentIndexes.push(i); });
  const args = ["-y", "-hide_banner", "-nostats"];
  for (const f of inputs) args.push("-i", f);
  // مصدر بلا صوت؟ أضف مسارًا صامتًا بنفس مدته بدل أن يفشل الدمج
  for (const i of silentIndexes) {
    const dur = probes[i].duration || 0.1;
    args.push("-f", "lavfi", "-t", String(Math.max(dur, 0.1).toFixed(3)), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }
  const silentOffset = inputs.length;
  const silentOf = new Map(silentIndexes.map((s, k) => [s, silentOffset + k]));

  const n = inputs.length;
  const parts = [];
  const maps = [];
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    const audioIn = silentOf.has(i) ? silentOf.get(i) : i;
    parts.push(`[${audioIn}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    maps.push(`[v${i}][a${i}]`);
  }
  parts.push(`${maps.join("")}concat=n=${n}:v=1:a=1[vout][aout]`);
  const filter = parts.join(";");

  args.push(
    "-filter_complex", filter,
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-crf", "18", "-preset", LIMITS.ffmpegPreset,
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-progress", "pipe:1", outputPath
  );

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    let lastPct = -1;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new HttpError(500, "تجاوز الترميز المهلة الزمنية المسموحة")); }, 280_000);
    child.stdout.on("data", (d) => {
      // قراءة out_time_us من -progress pipe:1 وحساب النسبة من المدة الإجمالية (كسر 0..1)
      const text = d.toString();
      const m = /out_time_us=(\d+)/g;
      let match;
      while ((match = m.exec(text)) !== null) {
        const us = Number(match[1]);
        if (!Number.isFinite(us) || us < 0 || totalDuration <= 0) continue;
        const pct = Math.min(0.999, us / 1e6 / totalDuration);
        const step = Math.floor(pct * 100); // إرسال كل 1% فقط لتقليل الكتابة على القاعدة
        if (step !== lastPct && onProgress) { lastPct = step; onProgress(pct); }
      }
    });
    child.stderr.on("data", (d) => (err += d.toString().slice(-4000)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new HttpError(500, `فشل ترميز الدمج (رمز ${code}): ${err.slice(-400)}`));
    });
    child.on("error", (e) => { clearTimeout(timer); reject(new HttpError(500, `تعذر تشغيل ffmpeg: ${e.message}`)); });
  });
}

module.exports = { ffmpegPath, ffprobePath, probeFile, planInputs, encode };
