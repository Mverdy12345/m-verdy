/* خادم تطوير محلي يحاكي بيئة Vercel: يوزّع المسارات الديناميكية ويضعها في req.query ثم يستدعي دوال api/ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
require("./lib/util"); // لتحميل .env يدويًا

const PORT = Number(process.env.PORT) || 3011;
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

// خريطة المسارات → دوال Vercel (المسارات الديناميكية تُحقن في req.query كما يفعل Vercel)
const ROUTES = [
  { re: /^\/api\/jobs\/([^/]+)\/video\/?$/, fn: () => require("./api/jobs/[id]/video"), params: { id: 1 } },
  { re: /^\/api\/jobs\/([^/]+)\/process\/?$/, fn: () => require("./api/jobs/[id]/process"), params: { id: 1 } },
  { re: /^\/api\/jobs\/([^/]+)\/?$/, fn: () => require("./api/jobs/[id]"), params: { id: 1 } },
  { re: /^\/api\/jobs\/?$/, fn: () => require("./api/jobs") },
  { re: /^\/api\/upload\/?$/, fn: () => require("./api/upload") },
  { re: /^\/api\/config\/?$/, fn: () => require("./api/config") },
  { re: /^\/api\/cron\/?$/, fn: () => require("./api/cron") },
];

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  // حقن معاملات المسار الديناميكي في req.query (سلوك Vercel)
  for (const r of ROUTES) {
    const m = r.re.exec(pathname);
    if (m) {
      req.query = { ...parsed.query };
      if (r.params) for (const [key, group] of Object.entries(r.params)) req.query[key] = m[group];
      const handler = r.fn();
      try {
        await handler(req, res);
      } catch (e) {
        console.error("[dev-server] فشل المعالج:", e);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "خطأ داخلي في خادم التطوير" }));
        }
      }
      return;
    }
  }

  // ملفات ثابتة من public/ — وأي مسار آخر يُرجع الواجهة (سلوك SPA)
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) filePath = path.join(PUBLIC_DIR, "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // جرّب الواجهة الرئيسية بدلًا من 404
      return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end("Not Found"); }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      });
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[dev-server] خدمة الدمج تعمل محليًا على http://localhost:${PORT}`);
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.warn("[dev-server] تحذير: متغيرا Turso غير مضبوطين — أنشئ merger/.env من .env.example");
  }
});
