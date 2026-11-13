/* اختبار e2e حقيقي ضد خادم MCP يعمل: تهيئة جلسة + الأدوات الخمس + التوليد والتبديل التسلسلي.
   الاستخدام: node scripts/e2e-mcp.js <phase>
   phase 1: مفاتيح (خاطئ أولًا ثم صحيح) + health + initialize + tools/list + صورة e2e مع التبديل + list_media
   phase 2: فيديو e2e مع متابعة get_task حتى الرابط النهائي
   phase 3: دمج e2e بمقطعين عامين + رفض مقطع واحد و11 مقطعًا + get_task لمهمة مجهولة
   المتغيرات: BASE (افتراضي http://localhost:3000)، KIE_API_KEY (الرسمي للمرحلة 1) */
"use strict";
const BASE = process.env.BASE || "http://localhost:3000";
let idSeq = 10;

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✔ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✘ ${name}${extra ? " — " + extra : ""}`); }
}

function nextId() { return ++idSeq; }

// استدعاء MCP raw: يعالج استجابة SSE (bث الإشعارات) ويستخرج الرد المطابق للمعرف
async function rawMcp(body) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const ct = res.headers.get("content-type") || "";
  const id = body.id;
  // الإشعارات (بلا id) قد تُرجع 202 بجسم فارغ — لا رد متوقع
  if (!ct || ct.includes("202") || res.status === 202) {
    await res.text().catch(() => "");
    return { result: null, sawProgress: false, contentType: ct };
  }
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    let result = null;
    let sawProgress = false;
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const j = JSON.parse(payload);
        if (j.method === "notifications/progress") sawProgress = true;
        if (id !== undefined && j.id === id && (j.result || j.error)) result = j;
      } catch { /* إطار غير JSON */ }
    }
    return { result, sawProgress, contentType: ct };
  }
  const j = await res.json();
  return { result: j, sawProgress: false, contentType: ct };
}

async function toolCall(name, args) {
  const { result } = await rawMcp({
    jsonrpc: "2.0", id: nextId(), method: "tools/call",
    params: { name, arguments: args },
  });
  if (!result) throw new Error("لا يوجد رد للأداة " + name);
  if (result.error) {
    // أخطاء التحقق من المخطط (zod) — رسالة الخطأ تصل من هنا
    return { text: String(result.error.message || ""), isError: true, raw: null };
  }
  const text = result.result?.content?.[0]?.text || "";
  return { text, isError: !!result.result?.isError, raw: result.result };
}

async function jfetch(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function extractTaskId(text) {
  const m = /task_id:\s*([0-9a-fA-F-]{10,50})/.exec(text);
  return m ? m[1] : null;
}
function extractUrl(text) {
  const m = /(https?:\/\/[^\s)"']+)/.exec(text);
  return m ? m[1] : null;
}

// ---------- المرحلة 1 ----------
async function phase1() {
  console.log("=== المرحلة 1: health + مفاتيح + initialize + tools/list + صورة e2e مع تبديل تسلسلي ===");

  // health
  const h = await jfetch("GET", "/api/health");
  ok("GET /api/health ok:true", h.json?.ok === true);
  ok("database = turso-connected", h.json?.database === "turso-connected");
  ok("merger.healthy = true", h.json?.merger?.healthy === true);
  ok("mcpEndpoint = /mcp و authRequired=false", h.json?.mcpEndpoint === "/mcp" && h.json?.authRequired === false);
  ok("health يعرض الموديلين بالمزودين", Array.isArray(h.json?.models) && h.json.models.length === 2);

  // تنظيف مفاتيح اختبار سابقة (ليجعل المرحلة قابلة لإعادة التشغيل)
  const prev = await jfetch("GET", "/api/keys");
  for (const k of prev.json?.keys || []) {
    if (["مفتاح خاطئ للاختبار", "المفتاح الرئيسي"].includes(k.label)) await jfetch("DELETE", `/api/keys/${k.id}`);
  }

  // إضافة مفتاح خاطئ أولًا (سيُجرَّب أولًا ويُعطَّل تلقائيًا) ثم المفتاح الرسمي
  const fake = await jfetch("POST", "/api/keys", { provider: "kie", api_key: "INVALID-TEST-KEY-0000000000", label: "مفتاح خاطئ للاختبار" });
  ok("إضافة مفتاح خاطئ → 201", fake.status === 201);
  const real = await jfetch("POST", "/api/keys", { provider: "kie", api_key: process.env.KIE_API_KEY, label: "المفتاح الرئيسي" });
  ok("إضافة المفتاح الرسمي → 201 (ترتيب التسلسلي: الخاطئ أولًا)", real.status === 201);
  const dup = await jfetch("POST", "/api/keys", { provider: "kie", api_key: process.env.KIE_API_KEY, label: "تكرار" });
  ok("رفض التكرار → 409", dup.status === 409);
  const keysList = await jfetch("GET", "/api/keys");
  ok("القائمة مُقنَّعة دائمًا (لا مفتاح كامل)", keysList.json?.keys?.length >= 2 && !JSON.stringify(keysList.json).includes(process.env.KIE_API_KEY));

  // initialize
  const init = await rawMcp({
    jsonrpc: "2.0", id: nextId(), method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "curl-test", version: "1.0" } },
  });
  const serverInfo = init.result?.result?.serverInfo;
  ok("initialize: اسم media-generator-mcp v1.2.0", serverInfo?.name === "media-generator-mcp" && serverInfo?.version === "1.2.0", `${serverInfo?.name}@${serverInfo?.version}`);
  ok("initialize: instructions الحرفية موجودة", init.result?.result?.instructions?.includes("automatically switches API keys in strict order") === true);
  await rawMcp({ jsonrpc: "2.0", method: "notifications/initialized" });

  // tools/list
  const tl = await rawMcp({ jsonrpc: "2.0", id: nextId(), method: "tools/list" });
  const tools = tl.result?.result?.tools || [];
  ok("tools/list يعرض الأدوات الخمس", tools.length === 5, tools.map((t) => t.name).join(", "));
  const mergeTool = tools.find((t) => t.name === "merge_videos");
  const mergeProps = mergeTool?.inputSchema?.properties || {};
  ok("merge بدون resolution/fps وبحد maxItems 10", !mergeProps.resolution && !mergeProps.fps && mergeProps.urls?.maxItems === 10 && mergeProps.task_ids?.maxItems === 10);
  const imgTool = tools.find((t) => t.name === "generate_image");
  ok("generate_image بمخطط المواصفة (aspect_ratio/resolution/background/output_format)", !!imgTool?.inputSchema?.properties?.aspect_ratio && imgTool.inputSchema.properties.resolution.default === "1K");
  const vidTool = tools.find((t) => t.name === "generate_video");
  ok("generate_video بمخطط المواصفة (enable_audio/duration 1..15)", vidTool?.inputSchema?.properties?.duration?.maximum === 15 && vidTool.inputSchema.properties.enable_audio.default === true);

  // توليد صورة: المفتاح الخاطئ يُجرَّب أولًا → يُعطَّل → المهمة تكتمل على المفتاح الرسمي بنفس task_id
  console.log("  ... توليد صورة (قد يستغرق ~15-60 ثانية)");
  const img = await toolCall("generate_image", { prompt: "a tiny paper boat floating on calm blue water at sunrise, minimal style", wait_seconds: 75 });
  ok("generate_image اكتملت برسالة النجاح العربية", img.text.includes("تم توليد الصورة بنجاح"), img.text.slice(0, 90));
  const imgUrl = extractUrl(img.text);
  ok("رابط الصورة مباشر https", !!imgUrl && imgUrl.startsWith("https://"));
  const keysAfter = await jfetch("GET", "/api/keys");
  const fakeKey = (keysAfter.json?.keys || []).find((k) => k.label === "مفتاح خاطئ للاختبار");
  const realKey = (keysAfter.json?.keys || []).find((k) => k.label === "المفتاح الرئيسي");
  ok("المفتاح الخاطئ عُطِّل تلقائيًا (disabled)", fakeKey?.status === "disabled");
  ok("المفتاح الرسمي سليم مع عدّاد نجاح", realKey?.status === "active" && realKey?.success_count >= 1);
  ok("لم يصل العميل أي ذكر للمفاتيح أو الرصيد", !img.text.includes("مفتاح") && !img.text.toLowerCase().includes("key") && !img.text.includes("رصيد"), "");

  // الرابط يعمل فعلًا
  if (imgUrl) {
    const probe = await fetch(imgUrl, { method: "HEAD", signal: AbortSignal.timeout(15000) });
    ok("رابط الصورة يعمل (HTTP 200)", probe.status === 200);
  }

  // list_media
  const lm = await toolCall("list_media", { limit: 5 });
  ok("list_media يعرض المهام المخزنة بروابطها من الأحدث", lm.text.includes("أحدث الوسائط المخزنة") && lm.text.includes("task_id:"));
}

// ---------- المرحلة 2 ----------
async function phase2() {
  console.log("=== المرحلة 2: فيديو e2e — task_id فوري ثم get_task حتى الرابط ===");
  const vid = await toolCall("generate_video", {
    prompt: "A cute orange kitten playing with a ball of yarn in a sunny living room, it meows happily once",
    duration: 8, resolution: "480p", wait_seconds: 20,
  });
  ok("generate_video يعيد مهمة قيد المعالجة مع task_id", vid.text.includes("قيد المعالجة") && vid.text.includes("task_id:"), vid.text.slice(0, 80));
  const taskId = extractTaskId(vid.text);
  ok("task_id بصيغة UUID", !!taskId && /^[0-9a-fA-F-]{20,50}$/.test(taskId || ""));

  // المتابعة بـ get_task كل ~10 ثوانٍ حتى الاكتمال (حد أقصى 8 دقائق)
  const deadline = Date.now() + 8 * 60 * 1000;
  let finalText = vid.text;
  let completed = false;
  let polls = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10000));
    polls++;
    const g = await toolCall("get_task", { task_id: taskId });
    finalText = g.text;
    if (g.text.includes("تم توليد الفيديو بنجاح")) { completed = true; break; }
    if (g.text.includes("فشلت المهمة")) break;
    process.stdout.write(`  ... استطلاع #${polls}: ${finalText.slice(0, 60).replace(/\n/g, " ")}\n`);
  }
  ok("get_task أكمل الفيديو برابط نهائي", completed, finalText.slice(0, 100));
  const vidUrl = extractUrl(finalText);
  if (completed && vidUrl) {
    const probe = await fetch(vidUrl, { method: "HEAD", signal: AbortSignal.timeout(20000) });
    ok("رابط الفيديو يعمل", probe.status === 200 || probe.status === 302);
  }
}

// ---------- المرحلة 3 ----------
async function phase3() {
  console.log("=== المرحلة 3: دمج e2e بمقطعين عامين + رفض الحالات غير الصحيحة ===");

  // رفض مقطع واحد
  const one = await toolCall("merge_videos", { urls: ["https://www.w3schools.com/html/mov_bbb.mp4"] });
  ok("مقطع واحد → رسالة «الدمج يحتاج مقطعَين على الأقل»", one.isError === true && one.text.includes("مقطعَين على الأقل"));

  // رفض 11 مقطعًا
  const eleven = await toolCall("merge_videos", { urls: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`) });
  ok("11 مقطعًا → «أقصى عدد مقاطع للدمج هو 10»", eleven.isError === true && eleven.text.includes("أقصى عدد مقاطع للدمج هو 10"));

  // get_task لمهمة مجهولة
  const unknown = await toolCall("get_task", { task_id: "does-not-exist-123" });
  ok("get_task مجهولة → رسالة عربية واضحة", unknown.isError === true && unknown.text.includes("لا توجد مهمة بالمعرّف"));

  // دمج حقيقي بمقطعين عامين (مثل المواصفة)
  console.log("  ... دمج مقطعين عامين (~15-40 ثانية)");
  const merged = await toolCall("merge_videos", {
    urls: [
      "https://www.w3schools.com/html/mov_bbb.mp4",
      "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
    ],
    wait_seconds: 120,
  });
  ok("الدمج اكتمل برسالة النجاح العربية", merged.text.includes("تم دمج المقاطع بنجاح"), merged.text.slice(0, 80));
  ok("تحذير 24 ساعة مذكور حرفيًا", merged.text.includes("يُحذف من خدمة الدمج بعد ~24 ساعة"));
  const mergeUrl = extractUrl(merged.text);
  const isLocalTest = /localhost|127\.0\.0\.1/.test(BASE) || (mergeUrl && /localhost|127\.0\.0\.1/.test(mergeUrl));
  // محليًا: خدمة الدمج على localhost — على Vercel يكون الرابط عامًا بلا نطاق داخلي
  ok(
    "رابط الناتج يعمل ويُشغَّل" + (isLocalTest ? " (محليًا — النطاق الداخلي مقتصر على خادم الدمج المحلي)" : " (بدون نطاق داخلي غير عام)"),
    !!mergeUrl && (isLocalTest ? true : !/localhost|127\.0\.0\.1|10\.|192\.168\./.test(mergeUrl))
  );
  if (mergeUrl) {
    const probe = await fetch(mergeUrl, { headers: { Range: "bytes=0-1023" }, signal: AbortSignal.timeout(20000) });
    ok("بث الناتج بدعم Range (206)", probe.status === 206, probe.headers.get("content-range"));
  }
}

const phase = process.argv[2] || "1";
(async () => {
  if (phase === "1") await phase1();
  else if (phase === "2") await phase2();
  else if (phase === "3") await phase3();
  else { console.error("المرحلة غير معروفة"); process.exit(2); }
  console.log(`\n=== المرحلة ${phase}: ${passed} ناجح، ${failed} فاشل ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("خطأ فادح:", e.message); process.exit(1); });
