/* أدوات مشتركة: تحميل .env يدويًا، الحدود، الردود JSON، قراءة الجسم، توليد المعرفات، فحص الروابط العامة */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// تحميل يدوي لملف .env (بدون اعتماد خارجي) — محليًا فقط؛ على Vercel تُضبط المتغيرات من اللوحة
function loadEnv() {
  if (process.env.ENV_LOADED) return;
  process.env.ENV_LOADED = "1";
  try {
    const p = path.join(__dirname, "..", ".env");
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      }
    }
  } catch (_) { /* تجاهل أي فشل في القراءة */ }
}
loadEnv();

function int(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

const LIMITS = {
  maxSources: int("MAX_SOURCES", 10),
  sourceMaxBytes: int("SOURCE_MAX_MB", 200) * 1024 * 1024,
  outputMaxBytes: int("OUTPUT_MAX_MB", 150) * 1024 * 1024,
  maxTotalDurationSec: int("MAX_TOTAL_DURATION_SEC", 600),
  uploadChunkBytes: 4 * 1024 * 1024, // أجزاء الرفع ≤ 4MB (حد حجم الطلب في Vercel ≈ 4.5MB)
  chunkRowBytes: 2 * 1024 * 1024,    // صفوف Blobs في Turso ≤ 2MB (حد HTTP)
  ttlHours: 24,                       // كل الملفات تُحذف تلقائيًا بعد 24 ساعة
  ffmpegPreset: process.env.FFMPEG_PRESET || "medium",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Disposition",
};

// خطأ HTTP مع رسالة عربية — يُحوَّل لرد {"error": "..."}
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...CORS_HEADERS,
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// غلاف موحد للمعالجات: يحوّل أي استثناء إلى {"error": "..."} بالكود المناسب
function guard(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return sendError(res, e.status, e.message);
      console.error("[merger] خطأ غير متوقع:", e);
      sendError(res, 500, "خطأ داخلي غير متوقع في الخدمة");
    }
  };
}

// قراءة جسم الطلب بالكامل مع حد أقصى — يعمل على Vercel وعلى خادم التطوير alike
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new HttpError(413, `حجم الطلب يتجاوز الحد المسموح (${Math.floor(maxBytes / 1024)}KB)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (e) => reject(new HttpError(400, "فشل في قراءة جسم الطلب")));
  });
}

function parseJsonBody(req, maxBytes = 1024 * 1024) {
  return readBody(req, maxBytes).then((buf) => {
    if (!buf.length) return {};
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch (_) {
      throw new HttpError(400, "صيغة JSON غير صالحة في جسم الطلب");
    }
  });
}

// معرّف مهمة قصير فريد — مثل معرفات خدمة الدمج المشار إليها في المواصفة
function newId() {
  return crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "").slice(0, 12) || crypto.randomBytes(6).toString("hex");
}

// رابط الخدمة الأساسي من ترويسات الطلب (يعمل محليًا وعلى Vercel)
function baseUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|0\.0\.0\.0|.*\.local)$/i;

// فحص صارم: رابط مباشر عام http/https فقط — يمنع SSRF والنطاقات الداخلية
function isPublicHttpUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!url.hostname) return false;
    if (PRIVATE_HOST_RE.test(url.hostname)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

// تحليل ترويسة Range بصيغة bytes=start-end (end اختياري)
function parseRange(header, total) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return { invalid: true };
  let [, s, e] = m;
  if (s === "" && e === "") return { invalid: true };
  let start, end;
  if (s === "") {
    // لاحقة: آخر N بايت
    const n = Number(e);
    if (!Number.isFinite(n) || n <= 0) return { invalid: true };
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(s);
    end = e === "" ? total - 1 : Math.min(Number(e), total - 1);
    if (!Number.isFinite(start) || start >= total || start > end) return { invalid: true, unsatisfiable: true };
  }
  return { start, end };
}

function expiresAtIso(hours = LIMITS.ttlHours) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const t = Date.parse(String(expiresAt).replace(" ", "T") + "Z");
  return Number.isFinite(t) && Date.now() >= t;
}

module.exports = { LIMITS, CORS_HEADERS, HttpError, sendJson, sendError, guard, readBody, parseJsonBody, newId, baseUrl, isPublicHttpUrl, parseRange, expiresAtIso, isExpired };
