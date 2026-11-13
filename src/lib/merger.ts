/* عميل خدمة دمج الفيديو (Video Merger API v2) — بلا مفاتيح أو توثيق.
   القواعد الحتمية: أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري —
   لا إعادة محاولة. أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → استمر بالاستعلام. */

export interface MergeStatusResult {
  state: "processing" | "completed" | "failed";
  progress?: number; // 0..100
  videoUrl?: string;
  error?: string;
  definitive?: boolean; // فشل حتمي من الخدمة نفسها
}

const BASE_RAW = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");
const PLACEHOLDER_RE = /xxxxxxxx|example\.com/i;

export function mergerConfigured(): boolean {
  return BASE_RAW.length > 8 && !PLACEHOLDER_RE.test(BASE_RAW) && BASE_RAW.startsWith("http");
}

export function mergerBase(): string {
  return BASE_RAW;
}

// تحليل الحالة الدفاعي: أكمل/فشل بأشكال متعددة + progress كسر 0..1 → *100
const DONE_STATES = ["done", "completed", "complete", "success", "succeeded", "finished"];
const FAIL_STATES = ["error", "failed", "failure", "cancelled"];

function normalizeProgress(p: unknown): number | undefined {
  const n = Number(p);
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (n <= 1) return Math.round(n * 100);
  if (n <= 100) return Math.round(n);
  return undefined;
}

async function callService(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null; networkError?: string }> {
  try {
    const res = await fetch(`${BASE_RAW}${path}`, {
      ...init,
      signal: AbortSignal.timeout(init?.method === "POST" ? 280_000 : 30_000),
    });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    return { status: res.status, body };
  } catch {
    // أخطاء شبكتنا — مؤقتة: نستمر بالاستعلام حتى انتهاء النافذة
    return { status: 0, body: null, networkError: "تعذر الوصول إلى خدمة الدمج (انقطاع شبكة أو مهلة)" };
  }
}

// POST /api/jobs {"videos":[...]} → {jobId, status, ...} — تُستدعى بعد تسجيل المهمة في Turso
export async function mergerCreateJob(urls: string[]): Promise<{ jobId: string }> {
  const { status, body, networkError } = await callService(`/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: urls }),
  });
  if (networkError) throw new Error(networkError);
  const jobId = body?.jobId as string | undefined;
  if (status >= 400 || !jobId) {
    // فشل معلن من الخدمة = حتمي
    throw new Error((body?.error as string) || `فشل إنشاء مهمة الدمج (HTTP ${status})`);
  }
  return { jobId };
}

// قفل في الذاكرة: تنفيذ process مرة واحدة فقط حتى لا يتزامن مع get_task
const processInFlight = new Set<string>();
const processLaunched = new Set<string>();

export function isProcessLaunched(jobId: string): boolean {
  return processLaunched.has(jobId) || processInFlight.has(jobId);
}

// POST /api/jobs/{id}/process — يُطلق مرة واحدة فقط (خلفيًا أو عبر get_task)
export function mergerLaunchProcess(jobId: string): void {
  if (processInFlight.has(jobId) || processLaunched.has(jobId)) return;
  processInFlight.add(jobId);
  processLaunched.add(jobId);
  // خلفيًا وبمرة واحدة — نتجاهل النتيجة: الاستطلاع عبر GET /api/jobs/{id} يكشفها لاحقًا
  void callService(`/api/jobs/${jobId}/process`, { method: "POST" })
    .catch(() => {})
    .finally(() => processInFlight.delete(jobId));
}

export async function mergerProcessSync(jobId: string): Promise<{ done?: boolean; conflict?: boolean }> {
  if (processInFlight.has(jobId)) return {};
  processInFlight.add(jobId);
  try {
    const { status, body } = await callService(`/api/jobs/${jobId}/process`, { method: "POST" });
    if (status === 200 && body?.status === "done") return { done: true };
    if (status === 202 || status === 409) return { conflict: true };
    return {};
  } finally {
    processInFlight.delete(jobId);
  }
}

// GET /api/jobs/{id} — 404 → فشل نهائي: المهمة حُذفت أو انتهت صلاحيتها بعد 24 ساعة
export async function mergerStatus(jobId: string): Promise<MergeStatusResult> {
  const { status, body, networkError } = await callService(`/api/jobs/${jobId}`, { method: "GET" });
  if (networkError) {
    // مؤقتة — نستمر بالاستعلام
    return { state: "processing" };
  }
  if (status === 404) {
    return {
      state: "failed",
      definitive: true,
      error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
    };
  }
  if (status >= 400 || !body) {
    // انتبه: قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا (حتمي)
    return { state: "failed", definitive: true, error: (body?.error as string) || `فشل استعلام مهمة الدمج (HTTP ${status})` };
  }

  const rawStatus = String(body.status || "").toLowerCase();
  const progress = normalizeProgress(body.progress);
  const error = body.error as string | undefined;

  // error بدون status → failed فورًا
  if (error && !rawStatus) {
    return { state: "failed", definitive: true, error };
  }

  if (FAIL_STATES.includes(rawStatus) || (error && !DONE_STATES.includes(rawStatus))) {
    return { state: "failed", definitive: true, error: error || "فشلت مهمة الدمج في الخدمة" };
  }
  if (DONE_STATES.includes(rawStatus)) {
    // فضّل videoUrl ثم downloadUrl، وإن غابا و jobId موجود فاضبط رابط /video
    const videoUrl = (body.videoUrl as string) || (body.downloadUrl as string) || `${BASE_RAW}/api/jobs/${jobId}/video`;
    return { state: "completed", videoUrl, progress: 100 };
  }
  return { state: "processing", progress: progress ?? 0 };
}

// DELETE /api/jobs/{id} — تنظيف اختياري
export async function mergerDeleteJob(jobId: string): Promise<boolean> {
  const { status } = await callService(`/api/jobs/${jobId}`, { method: "DELETE" });
  return status >= 200 && status < 300;
}

// GET /api/config بمهلة 4 ثوانٍ — فحص الجهوزية لـ /api/health
export async function mergerHealthy(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const res = await fetch(`${BASE_RAW}/api/config`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}
