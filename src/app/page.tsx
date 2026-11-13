"use client";

/* لوحة الإدارة العربية (RTL): حالة الجهوزية + مدير المفاتيح + لوحة المهام + ربط السيرفر */
import { useCallback, useEffect, useRef, useState } from "react";

type Health = {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
};

type KeyItem = {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
};

type TaskItem = {
  id: string;
  provider: string | null;
  model: string;
  type: string;
  prompt: string;
  status: string;
  progress: number;
  result_urls: string[];
  error: string | null;
  attempts: number;
  created_at: string;
};

const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "جارية",
  pending: "معلّقة",
};
const STATUS_CLS: Record<string, string> = {
  completed: "bg-emerald-400/15 text-emerald-300",
  failed: "bg-red-400/15 text-red-300",
  processing: "bg-amber-400/15 text-amber-300",
  pending: "bg-sky-400/15 text-sky-300",
};
const KEY_STATUS_CLS: Record<string, string> = {
  active: "bg-emerald-400/15 text-emerald-300",
  exhausted: "bg-amber-400/15 text-amber-300",
  disabled: "bg-slate-400/15 text-slate-400",
};
const KEY_STATUS_AR: Record<string, string> = { active: "نشط", exhausted: "مستنزف", disabled: "معطّل" };

const TOOL_CHIPS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة بـ gpt-image-2-6/flare-text-to-image مع تبديل تلقائي للمفاتيح." },
  { name: "generate_video", desc: "توليد فيديو بـ grok-imagine-video-1-5-preview بصوت متزامن أصلي وimage-to-video اختياري." },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المعطى عبر urls أو task_ids." },
  { name: "get_task", desc: "تتبع أي مهمة (توليد أو دمج) بمعرّفها — حدّث كل ~10 ثوانٍ حتى الاكتمال." },
  { name: "list_media", desc: "أحدث الوسائط المخزنة بروابطها من قاعدة البيانات دون إعادة توليد." },
];

function Badge({ children, cls }: { children: React.ReactNode; cls?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${cls || "bg-slate-400/15 text-slate-300"}`}>
      {children}
    </span>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="rounded-lg border border-[#253052] bg-[#0d1322] px-3 py-1.5 text-xs font-bold text-slate-300 hover:border-sky-400/60"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "✔ تم النسخ" : "نسخ"}
    </button>
  );
}

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  // نموذج إضافة مفتاح
  const [newProvider, setNewProvider] = useState("kie");
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // تبويب ربط السيرفر
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [origin, setOrigin] = useState("");
  const tasksRef = useRef<HTMLDivElement>(null);

  const refreshHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health");
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  const refreshKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      const j = await r.json();
      setKeys(j.keys || []);
    } catch { /* تجاهل */ }
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=15");
      const j = await r.json();
      setTasks(j.tasks || []);
      if (j.stats) setStats(j.stats);
    } catch { /* تجاهل */ }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    refreshHealth();
    refreshKeys();
    refreshTasks();
    const t1 = setInterval(refreshHealth, 15000);
    const t2 = setInterval(refreshTasks, 5000); // لوحة المهام تتحدث تلقائيًا كل ~5 ثوانٍ
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [refreshHealth, refreshKeys, refreshTasks]);

  async function addKey() {
    setKeyMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: newProvider, api_key: newKey.trim(), label: newLabel.trim() }),
      });
      const j = await r.json();
      if (!r.ok) {
        setKeyMsg({ ok: false, text: j.error || "فشل إضافة المفتاح" });
        return;
      }
      setKeyMsg({ ok: true, text: `أُضيف المفتاح (${j.masked}) — سيُجرَّب في الترتيب التسلسلي رقم ${j.order + 1}` });
      setNewKey("");
      setNewLabel("");
      refreshKeys();
    } catch {
      setKeyMsg({ ok: false, text: "خطأ شبكة عند إضافة المفتاح" });
    }
  }

  async function toggleKey(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: k.status === "disabled" ? "active" : "disabled" }),
    });
    refreshKeys();
  }

  async function removeKey(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    refreshKeys();
  }

  const mcpUrl = `${origin}/mcp`;
  const authHeaders = health?.authRequired ? `,\n        "headers": {"Authorization": "Bearer <MCP_ACCESS_TOKEN>"}` : "";
  const snippets = {
    chatgpt: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authHeaders}\n    }\n  }\n}`,
    claude: `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${authHeaders}\n    }\n  }\n}`,
    cursor: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authHeaders}\n    }\n  }\n}`,
  };

  return (
    <main className="mx-auto max-w-5xl px-4 pb-24 pt-6">
      {/* الهيدر + شارة الجهوزية */}
      <header className="pb-6 text-center">
        <h1 className="grad-text text-3xl font-extrabold">MCP Media Generator</h1>
        <p className="mt-1 text-sm text-slate-400">توليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — خادم MCP كامل مع تبديل مفاتيح تسلسلي</p>
        <div className="mt-3 flex items-center justify-center gap-2 text-xs">
          {health ? (
            <>
              <Badge cls={health.ok ? "bg-emerald-400/15 text-emerald-300" : "bg-red-400/15 text-red-300"}>
                {health.ok ? "● Turso متصل" : "● غير متصل"}
              </Badge>
              <Badge cls={health.merger.healthy ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"}>
                {health.merger.healthy ? "● خدمة الدمج جاهزة" : "● خدمة الدمج غير مضبوطة"}
              </Badge>
              {health.authRequired && <Badge cls="bg-violet-400/15 text-violet-300">● /mcp محمي بـ Bearer</Badge>}
            </>
          ) : (
            <Badge cls="bg-red-400/15 text-red-300">● تعذر جلب حالة الجهوزية</Badge>
          )}
        </div>
      </header>

      {/* أ) مدير المفاتيح */}
      <section className="rounded-2xl border border-[#253052] bg-gradient-to-b from-[#141b2e] to-[#1a2340] p-5 shadow-xl">
        <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
          <span className="grad-btn inline-block h-2.5 w-2.5 rounded-full" /> مدير المفاتيح
        </h2>
        <div className="grid gap-2 md:grid-cols-4">
          <select
            className="rounded-xl border border-[#253052] bg-[#0a0e1a] px-3 py-2.5 text-sm"
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value)}
          >
            <option value="kie">kie.ai</option>
            <option value="cometapi">CometAPI</option>
          </select>
          <input
            className="rounded-xl border border-[#253052] bg-[#0a0e1a] px-3 py-2.5 text-sm md:col-span-1"
            placeholder="تسمية اختيارية"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <input
            className="ltr rounded-xl border border-[#253052] bg-[#0a0e1a] px-3 py-2.5 text-sm md:col-span-1"
            placeholder="API Key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <button className="grad-btn rounded-xl px-4 py-2.5 text-sm font-bold disabled:opacity-50" disabled={!newKey.trim()} onClick={addKey}>
            إضافة المفتاح
          </button>
        </div>
        {keyMsg && <p className={`mt-2 text-xs ${keyMsg.ok ? "text-emerald-300" : "text-red-300"}`}>{keyMsg.text}</p>}

        <p className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-6 text-amber-200/90">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </p>

        <div className="mt-3 space-y-2">
          {keys.length === 0 && <p className="py-3 text-center text-xs text-slate-500">لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد.</p>}
          {keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-[#253052] bg-[#0a0e1a] px-3 py-2.5 text-xs">
              <span className="font-bold">{k.provider === "kie" ? "kie.ai" : "CometAPI"}</span>
              <span className="ltr rounded-lg bg-[#0d1322] px-2 py-1 font-mono">{k.masked}</span>
              {k.label && <span className="text-slate-400">{k.label}</span>}
              <Badge cls={KEY_STATUS_CLS[k.status] || "bg-slate-400/15"}>{KEY_STATUS_AR[k.status] || k.status}</Badge>
              <span className="text-slate-400">
                استخدام {k.usage_count} · نجاح {k.success_count} · فشل {k.fail_count}
              </span>
              {k.last_error && <span className="max-w-full truncate text-red-300/80" title={k.last_error}>آخر خطأ: {k.last_error}</span>}
              <span className="flex-1" />
              <button className="rounded-lg border border-[#253052] px-2.5 py-1 hover:border-sky-400/60" onClick={() => toggleKey(k)}>
                {k.status === "disabled" ? "تنشيط" : "تعطيل"}
              </button>
              <button className="rounded-lg border border-red-400/30 px-2.5 py-1 text-red-300 hover:bg-red-400/10" onClick={() => removeKey(k)}>
                حذف
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ب) لوحة المهام */}
      <section ref={tasksRef} className="mt-4 rounded-2xl border border-[#253052] bg-gradient-to-b from-[#141b2e] to-[#1a2340] p-5 shadow-xl">
        <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
          <span className="grad-btn inline-block h-2.5 w-2.5 rounded-full" /> لوحة المهام
          <span className="text-xs font-normal text-slate-500">تتحدث تلقائيًا كل 5 ثوانٍ</span>
        </h2>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {[
            { l: "إجمالي", v: stats.total, c: "text-sky-300" },
            { l: "مكتملة", v: stats.completed, c: "text-emerald-300" },
            { l: "فاشلة", v: stats.failed, c: "text-red-300" },
            { l: "جارية", v: stats.processing, c: "text-amber-300" },
          ].map((s) => (
            <div key={s.l} className="rounded-xl border border-[#253052] bg-[#0a0e1a] p-3 text-center">
              <div className={`grad-text text-xl font-extrabold ${s.c}`}>{s.v}</div>
              <div className="mt-1 text-xs text-slate-400">{s.l}</div>
            </div>
          ))}
        </div>

        <div className="mt-3 space-y-2">
          {tasks.length === 0 && <p className="py-3 text-center text-xs text-slate-500">لا توجد مهام بعد — استدعِ generate_image من عميل MCP لبدء التوليد.</p>}
          {tasks.map((t) => (
            <div key={t.id} className="rounded-xl border border-[#253052] bg-[#0a0e1a] p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Badge cls="bg-violet-400/15 text-violet-300">{TYPE_AR[t.type] || t.type}</Badge>
                <Badge cls={STATUS_CLS[t.status] || "bg-slate-400/15"}>{STATUS_AR[t.status] || t.status}</Badge>
                <span className="ltr font-mono text-slate-300">{t.model}</span>
                <span className="text-slate-500">· محاولات {t.attempts}</span>
                <span className="flex-1" />
                <span className="text-slate-500">{t.created_at?.slice(0, 19)}</span>
              </div>
              {t.prompt && <p className="mt-1.5 truncate text-slate-400">«{t.prompt}»</p>}
              {t.status !== "failed" && t.status !== "completed" && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#0d1322]">
                  <div className="h-full rounded-full bg-gradient-to-l from-sky-400 to-violet-400 transition-all" style={{ width: `${t.progress}%` }} />
                </div>
              )}
              {t.error && <p className="mt-1.5 text-red-300/90">الخطأ: {t.error}</p>}
              {t.result_urls.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {t.result_urls.map((u, i) => (
                    <a key={i} href={u} target="_blank" rel="noreferrer" className="ltr truncate rounded-lg border border-emerald-400/30 bg-emerald-400/5 px-2 py-1 text-emerald-300 hover:bg-emerald-400/10">
                      فتح الرابط ↗
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ج) ربط السيرفر */}
      <section className="mt-4 rounded-2xl border border-[#253052] bg-gradient-to-b from-[#141b2e] to-[#1a2340] p-5 shadow-xl">
        <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">
          <span className="grad-btn inline-block h-2.5 w-2.5 rounded-full" /> ربط السيرفر
        </h2>
        <div className="flex items-center gap-2">
          <code className="ltr flex-1 truncate rounded-xl border border-[#253052] bg-[#0a0e1a] px-3 py-2.5 font-mono text-sm">{mcpUrl}</code>
          <CopyBtn text={mcpUrl} />
        </div>

        <div className="mt-3 flex gap-2 text-xs">
          {([["chatgpt", "ChatGPT / GPT Agents"], ["claude", "Claude Desktop"], ["cursor", "Cursor / Windsurf / Cline"]] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-xl px-3 py-1.5 font-bold ${tab === id ? "grad-btn" : "border border-[#253052] text-slate-300"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative mt-2">
          <pre className="code">{snippets[tab]}</pre>
          <div className="absolute left-3 top-3">
            <CopyBtn text={snippets[tab]} />
          </div>
        </div>
        {tab === "chatgpt" && (
          <p className="mt-2 text-xs text-slate-400">في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».</p>
        )}
        {tab === "claude" && <p className="mt-2 text-xs text-slate-400">احفظه في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.</p>}
        {tab === "cursor" && <p className="mt-2 text-xs text-slate-400">احفظه في mcp.json داخل Cursor / Windsurf / Cline.</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          {TOOL_CHIPS.map((t) => (
            <div key={t.name} className="max-w-full rounded-xl border border-[#253052] bg-[#0a0e1a] px-3 py-2">
              <span className="ltr font-mono text-xs font-bold text-sky-300">{t.name}</span>
              <p className="mt-0.5 text-[11px] leading-5 text-slate-400">{t.desc}</p>
            </div>
          ))}
        </div>

        <p className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-6 text-amber-200/90">
          الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف.
          أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
        </p>
      </section>

      <footer className="pt-6 text-center text-[11px] text-slate-600">
        media-generator-mcp v1.2.0 — روابط فقط: لا تُنزَّل أي وسائط على هذا السيرفر إطلاقًا.
      </footer>
    </main>
  );
}
