/* منسّق التوليد: runGeneration + refreshTask + runMerge + refreshMergeTask
   القواعد الذهبية المنفَّذة هنا:
   - سجل المهمة في Turso قبل أي نداء خارجي.
   - جرّب المفاتيح بالترتيب الصارم؛ أول نجاح يربط المهمة بالمزود والمفتاح.
   - فشل مفتاح/رصيد في أي مرحلة → أعد الإنشاء على المفتاح التالي بنفس task_id (صامت تمامًا للعميل).
   - مهمة فشلت على كل المفاتيح تبقى processing وتُعاد محاولتها مع كل get_task (تهدئة ~45 ثانية).
   - النموذج الذكي لا يرى أخطاء مفاتيح/رصيد أبدًا. */
import { randomUUID } from "crypto";
import { resolveModel, type ModelDef, type ProviderId } from "./models";
import { classifyProviderError, looksLikeKeyFailure } from "./errors";
import { getKeyPool, bumpKey, noKeysMessage } from "./keys";
import { getTask, insertTask, updateTask, getKey, type TaskRow, type KeyRow, type Attempt } from "./turso";
import { kieAdapter } from "./providers/kie";
import { cometapiAdapter } from "./providers/cometapi";
import type { ProviderAdapter, ProviderInput, ProviderCheckResult } from "./providers/types";
import { mergerConfigured, mergerCreateJob, mergerLaunchProcess, mergerStatus, mergerProcessSync, isProcessLaunched, type MergeStatusResult } from "./merger";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

const PROGRESS_INTERVAL_MS = 3000; // بث تقدم كل ~3 ثوانٍ
const RETRY_COOLDOWN_MS = 45_000; // تهدئة إعادة المحاولة بعد فشل كل المفاتيح
const POLL_INTERVAL_MS = 3000;

export interface ProgressSender {
  (percent: number, message: string): Promise<void> | void;
}

function noopProgress(): ProgressSender {
  return async () => {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function attemptFrom(provider: string, key: { id: string; label: string }, ok: boolean, errorClass?: string, error?: string): Attempt {
  return { provider, keyId: key.id, keyLabel: key.label || key.id, ok, errorClass, error: error?.slice(0, 300), at: new Date().toISOString() };
}

function buildProviderInput(model: ModelDef, provider: ProviderId, params: Record<string, unknown>, type: "image" | "video"): ProviderInput {
  return {
    type,
    providerModel: model.providerModel[provider] || model.canonical,
    prompt: (params.prompt as string) || "",
    aspect_ratio: (params.aspect_ratio as string) || "auto",
    resolution: (params.resolution as string) || (type === "image" ? "1K" : "480p"),
    background: params.background as string | undefined,
    output_format: (params.output_format as string) || (type === "image" ? "png" : undefined),
    image_url: params.image_url as string | undefined,
    enable_audio: type === "video" ? (params.enable_audio as boolean | undefined) ?? true : undefined,
    duration: type === "video" ? ((params.duration as number) || 8) : undefined,
  };
}

// ---------- الإنشاء على مرشّح واحد ----------
function createOnCandidate(
  provider: ProviderId,
  key: KeyRow,
  input: ProviderInput
): Promise<{ taskId: string; urls?: string[] }> {
  const adapter = ADAPTERS[provider];
  if (input.type === "image" && adapter.createImageSync) {
    return adapter.createImageSync(key, input).then((r) => ({ taskId: "", urls: r.urls }));
  }
  return adapter.createTask(key, input).then((r) => ({ taskId: r.providerTaskId }));
}

// ---------- محاولة الإنشاء على كل المرشحين بالترتيب — تحدّث نفس صف المهمة (نفس task_id) ----------
async function attemptCreation(
  taskId: string,
  model: ModelDef,
  type: "image" | "video",
  params: Record<string, unknown>,
  sendProgress: ProgressSender,
  startAfterKeyId?: string
): Promise<{ bound: boolean; provider?: ProviderId; key?: KeyRow; urls?: string[]; paramsError?: string }> {
  const pool = await getKeyPool(model.providers);
  const startIdx = startAfterKeyId ? pool.findIndex((k) => k.id === startAfterKeyId) + 1 : 0;
  for (const key of pool.slice(startIdx)) {
    const provider = key.provider as ProviderId;
    const input = buildProviderInput(model, provider, params, type);
    try {
      const created = await createOnCandidate(provider, key, input);
      await bumpKey(key.id, { ok: true });
      await updateTask(taskId, {
        provider,
        provider_task_id: created.taskId || null,
        key_id: key.id,
        status: created.urls ? "completed" : "processing",
        progress: created.urls ? 100 : 3,
        result_urls_json: created.urls ? JSON.stringify(created.urls) : undefined,
        appendAttempt: attemptFrom(provider, key, true),
      });
      await sendProgress(5, "قيد التوليد… 5%");
      return { bound: true, provider, key, urls: created.urls };
    } catch (e) {
      const err = e as Error & { status?: number };
      const cls = classifyProviderError(err.status ?? 0, err.message || "");
      await bumpKey(key.id, { ok: false, error: err.message, status: err.status });
      await updateTask(taskId, { appendAttempt: attemptFrom(provider, key, false, cls, err.message) });
      // خطأ معطيات = توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
      if (cls === "params") return { bound: false, paramsError: err.message };
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي صامتًا
      continue;
    }
  }
  return { bound: false };
}

// ---------- نافذة الانتظار: استعلام كل 3 ثوانٍ + بث تقدم ----------
type WaitOutcome =
  | { timedOut: true }
  | { completed: true; urls: string[] }
  | { failedKeyLike: true; error: string }
  | { failedFinal: true; error: string };

async function waitWindow(
  taskId: string,
  provider: ProviderId,
  key: KeyRow,
  providerTaskId: string,
  waitSeconds: number,
  dbProgress: number,
  sendProgress: ProgressSender
): Promise<WaitOutcome> {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastNotify = 0;
  let lastPct = dbProgress;
  while (Date.now() < deadline) {
    let check: ProviderCheckResult;
    try {
      check = await ADAPTERS[provider].checkTask(key, providerTaskId);
    } catch (e) {
      const err = e as Error & { status?: number };
      const cls = classifyProviderError(err.status ?? 0, err.message || "");
      await bumpKey(key.id, { ok: false, error: err.message, status: err.status });
      if (cls === "disabled" || cls === "exhausted") return { failedKeyLike: true, error: err.message };
      if (cls === "params") return { failedFinal: true, error: `معطيات غير مقبولة: ${err.message}` };
      // temporary → نستمر بالاستعلام حتى انتهاء النافذة
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (check.status === "completed" && check.urls?.length) return { completed: true, urls: check.urls };
    if (check.status === "failed") {
      if (looksLikeKeyFailure(check.error || "")) return { failedKeyLike: true, error: check.error || "" };
      return { failedFinal: true, error: check.error || "فشل التوليد" };
    }
    const pct = Math.max(lastPct, Math.min(95, check.progress ?? 0));
    if (pct !== lastPct) {
      lastPct = pct;
      await updateTask(taskId, { progress: pct });
    }
    const now = Date.now();
    if (now - lastNotify >= PROGRESS_INTERVAL_MS) {
      lastNotify = now;
      await sendProgress(pct, `قيد التوليد… ${pct}%`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { timedOut: true };
}

// ---------- قيادة المهمة الجارية حتى النهاية أو انتهاء النافذة ----------
async function driveTask(
  task: TaskRow,
  provider: ProviderId,
  key: KeyRow,
  waitSeconds: number,
  sendProgress: ProgressSender
): Promise<GenerationOutcome> {
  let currentProvider = provider;
  let currentKey = key;
  for (;;) {
    const outcome = await waitWindow(task.id, currentProvider, currentKey, task.provider_task_id!, waitSeconds, task.progress, sendProgress);

    if ("timedOut" in outcome) {
      const t = (await getTask(task.id))!;
      return { task: t, message: formatTaskMessage(t) };
    }
    if ("completed" in outcome) {
      const t = (await updateTask(task.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify(outcome.urls) }))!;
      return { task: t, message: formatTaskMessage(t) };
    }
    if ("failedFinal" in outcome) {
      const t = (await updateTask(task.id, { status: "failed", error_message: outcome.error }))!;
      return { task: t, message: formatTaskMessage(t), isError: true };
    }
    // failedKeyLike → استئناف نفس المهمة على المفتاح التالي بنفس task_id
    await bumpKey(currentKey.id, { ok: false, error: outcome.error });
    const model = resolveModel(task.model);
    if (!model) return { task, message: formatTaskMessage(task), isError: true };
    const next = await attemptCreation(
      task.id,
      model,
      task.type === "image" ? "image" : "video",
      JSON.parse(task.params_json || "{}"),
      sendProgress,
      currentKey.id
    );
    if (!next.bound) {
      // لا مفتاح متبقٍ → تبقى processing بانتظار مفتاح صالح
      const t = (await updateTask(task.id, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" }))!;
      return { task: t, message: formatTaskMessage(t) };
    }
    if (next.urls) {
      const t = (await updateTask(task.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify(next.urls) }))!;
      return { task: t, message: formatTaskMessage(t) };
    }
    currentProvider = next.provider!;
    currentKey = next.key!;
    const t = (await updateTask(task.id, { provider: currentProvider, key_id: currentKey.id, status: "processing", progress: 3 }))!;
    task = t;
    waitSeconds = 15; // نوافذ لاحقة أقصر — الباقي يتكفل به get_task
  }
}

// ---------- التوليد (صورة/فيديو) ----------
export interface GenerateArgs {
  type: "image" | "video";
  prompt: string;
  model?: string;
  wait_seconds?: number;
  sendProgress?: ProgressSender;
  [k: string]: unknown;
}

export interface GenerationOutcome {
  task: TaskRow | null;
  message: string;
  isError?: boolean;
}

export async function runGeneration(args: GenerateArgs): Promise<GenerationOutcome> {
  const sendProgress = args.sendProgress || noopProgress();

  // 1) وحّد اسم الموديل عبر aliases — غير معروف → خطأ معطيات فوري
  const fallback = resolveModel(args.model) || resolveModel(args.type === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview");
  if (!fallback) {
    return { task: null, message: "❌ موديل غير معروف. المتاح: gpt-image-2-6/flare-text-to-image و grok-imagine-video-1-5-preview", isError: true };
  }

  // 2) المرشّحون بالترتيب الصارم — فارغ → رد no_keys
  const pool = await getKeyPool(fallback.providers);
  if (!pool.length) {
    return { task: null, message: noKeysMessage(fallback.canonical), isError: true };
  }

  const params: Record<string, unknown> = {
    prompt: args.prompt,
    aspect_ratio: (args.aspect_ratio as string) || "auto",
    resolution: args.resolution,
    background: args.background,
    output_format: args.output_format,
    image_url: args.image_url,
    enable_audio: args.enable_audio,
    duration: args.duration,
    model: fallback.canonical,
    type: args.type,
  };
  const waitSeconds = Math.min(240, Math.max(0, Math.floor(args.wait_seconds ?? (args.type === "image" ? 90 : 25))));

  // 3) سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: fallback.canonical,
    type: args.type,
    prompt: args.prompt,
    params_json: JSON.stringify(params),
    status: "pending",
  });
  let task = (await getTask(taskId))!;

  // 4) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
  const created = await attemptCreation(taskId, fallback, args.type, params, sendProgress);
  if (!created.bound) {
    if (created.paramsError) {
      task = (await updateTask(taskId, { status: "failed", error_message: `معطيات غير مقبولة: ${created.paramsError}` }))!;
      return { task, message: formatTaskMessage(task), isError: true };
    }
    // فشل الإنشاء على كل المفاتيح → processing برسالة داخلية (العميل يرى «قيد المعالجة» فقط)
    task = (await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" }))!;
    return { task, message: formatTaskMessage(task) };
  }
  if (created.urls) {
    task = (await getTask(taskId))!;
    return { task, message: formatTaskMessage(task) };
  }

  // 5) نافذة الانتظار مع بث تقدم حي — وبعدها العميل يتابع بـ get_task
  task = (await getTask(taskId))!;
  return driveTask(task, created.provider!, created.key!, waitSeconds, sendProgress);
}

// ---------- refreshTask (أداة get_task) ----------
export async function refreshTask(taskId: string): Promise<GenerationOutcome> {
  const task = await getTask(taskId);
  if (!task) {
    return {
      task: null,
      message: `❌ لا توجد مهمة بالمعرّف ${taskId}. تحقق من task_id أو استخدم list_media لعرض المهام المخزنة.`,
      isError: true,
    };
  }
  if (task.status === "completed" || task.status === "failed") {
    return { task, message: formatTaskMessage(task), isError: task.status === "failed" };
  }
  if (task.provider === "merger") return refreshMergeTask(task);

  const model = resolveModel(task.model);
  if (!model) return { task, message: formatTaskMessage(task) };

  // لم يبدأ الإنشاء أصلًا (فشل كل المفاتيح سابقًا) → أعِد المحاولة على نفس task_id بعد تهدئة 45 ثانية
  if (!task.provider_task_id) {
    const elapsed = Date.now() - new Date(task.updated_at.replace(" ", "T") + "Z").getTime();
    if (elapsed >= RETRY_COOLDOWN_MS) {
      const params = JSON.parse(task.params_json || "{}") as Record<string, unknown>;
      const created = await attemptCreation(task.id, model, task.type === "image" ? "image" : "video", params, noopProgress());
      if (!created.bound) {
        if (created.paramsError) {
          const t = (await updateTask(task.id, { status: "failed", error_message: `معطيات غير مقبولة: ${created.paramsError}` }))!;
          return { task: t, message: formatTaskMessage(t), isError: true };
        }
        return { task, message: formatTaskMessage(task) };
      }
      if (created.urls) {
        const t = (await getTask(task.id))!;
        return { task: t, message: formatTaskMessage(t) };
      }
      const fresh = (await getTask(task.id))!;
      return driveTask(fresh, created.provider!, created.key!, 20, noopProgress());
    }
    return { task, message: formatTaskMessage(task) };
  }

  // مهمة جارية عند المزود → حدّثها حية (مع نفس منطق التبديل)
  const provider = (task.provider || "kie") as ProviderId;
  let key = task.key_id ? await getKey(task.key_id) : null;
  if (!key || key.status === "disabled") {
    const pool = await getKeyPool([provider]);
    key = pool[0] || null;
  }
  if (!key) {
    // لا مفتاح متابعة لنفس المزود → استئناف على أي مفتاح متبقٍ بنفس task_id
    const next = await attemptCreation(task.id, model, task.type === "image" ? "image" : "video", JSON.parse(task.params_json || "{}"), noopProgress(), task.key_id || undefined);
    if (!next.bound) return { task, message: formatTaskMessage(task) };
    if (next.urls) {
      const t = (await getTask(task.id))!;
      return { task: t, message: formatTaskMessage(t) };
    }
    const fresh = (await getTask(task.id))!;
    return driveTask(fresh, next.provider!, next.key!, 15, noopProgress());
  }

  try {
    const check = await ADAPTERS[provider].checkTask(key, task.provider_task_id);
    if (check.status === "completed" && check.urls?.length) {
      const t = (await updateTask(task.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify(check.urls) }))!;
      return { task: t, message: formatTaskMessage(t) };
    }
    if (check.status === "failed") {
      const msg = check.error || "فشل التوليد";
      if (looksLikeKeyFailure(msg)) {
        await bumpKey(key.id, { ok: false, error: msg });
        const next = await attemptCreation(task.id, model, task.type === "image" ? "image" : "video", JSON.parse(task.params_json || "{}"), noopProgress(), key.id);
        if (!next.bound) {
          const t = (await updateTask(task.id, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" }))!;
          return { task: t, message: formatTaskMessage(t) };
        }
        if (next.urls) {
          const t = (await getTask(task.id))!;
          return { task: t, message: formatTaskMessage(t) };
        }
        const fresh = (await getTask(task.id))!;
        return driveTask(fresh, next.provider!, next.key!, 15, noopProgress());
      }
      const t = (await updateTask(task.id, { status: "failed", error_message: msg }))!;
      return { task: t, message: formatTaskMessage(t), isError: true };
    }
    const t = (await updateTask(task.id, { progress: Math.max(task.progress, Math.min(95, check.progress ?? task.progress)) }))!;
    return { task: t, message: formatTaskMessage(t) };
  } catch (e) {
    const err = e as Error & { status?: number };
    const cls = classifyProviderError(err.status ?? 0, err.message || "");
    await bumpKey(key.id, { ok: false, error: err.message, status: err.status });
    if (cls === "disabled" || cls === "exhausted") {
      // المفتاح انتهى أثناء المتابعة → استئناف على المفتاح التالي بنفس task_id
      const next = await attemptCreation(task.id, model, task.type === "image" ? "image" : "video", JSON.parse(task.params_json || "{}"), noopProgress(), key.id);
      if (!next.bound) {
        const t = (await updateTask(task.id, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" }))!;
        return { task: t, message: formatTaskMessage(t) };
      }
      if (next.urls) {
        const t = (await getTask(task.id))!;
        return { task: t, message: formatTaskMessage(t) };
      }
      const fresh = (await getTask(task.id))!;
      return driveTask(fresh, next.provider!, next.key!, 15, noopProgress());
    }
    // temporary → تبقى processing ونتابع في استدعاء get_task القادم
    return { task, message: formatTaskMessage(task) };
  }
}

// ---------- الدمج ----------
export interface MergeArgs {
  urls?: string[];
  task_ids?: string[];
  wait_seconds?: number;
  sendProgress?: ProgressSender;
}

export async function runMerge(args: MergeArgs): Promise<GenerationOutcome> {
  const sendProgress = args.sendProgress || noopProgress();

  if (!mergerConfigured()) {
    return {
      task: null,
      message: "❌ خدمة الدمج غير مهيأة: اضبط متغير البيئة MERGER_API_BASE برابط خدمة الدمج المنشورة ثم أعد المحاولة.",
      isError: true,
    };
  }

  // 1) حلّل task_ids أُولًا (بترتيبها) ثم الروابط المباشرة بنفس ترتيبها
  const collected: string[] = [];
  const problems: string[] = [];
  for (const tid of args.task_ids || []) {
    const t = await getTask(tid);
    if (!t) {
      problems.push(`المهمة ${tid}: غير موجودة`);
      continue;
    }
    if (t.status !== "completed") {
      problems.push(`المهمة ${tid}: حالتها ${t.status} وليست مكتملة`);
      continue;
    }
    const urls = JSON.parse(t.result_urls_json || "[]") as string[];
    if (!urls.length) {
      problems.push(`المهمة ${tid}: لا تحتوي روابط نتائج`);
      continue;
    }
    collected.push(urls[0]);
  }
  for (const u of args.urls || []) collected.push(u);

  // 2) تحقق صارم: ≥2 وكلها روابط مباشرة عامة، و≤10
  if (collected.length < 2) {
    let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (problems.length) msg += "\n\nتفاصيل المعرفات:\n" + problems.map((p) => `- ${p}`).join("\n");
    return { task: null, message: msg, isError: true };
  }
  if (collected.length > 10) {
    return { task: null, message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).", isError: true };
  }
  const bad = collected.filter((u) => !/^https?:\/\/.+/i.test(u));
  if (bad.length) {
    return {
      task: null,
      message: `❌ كل الروابط يجب أن تكون روابط فيديو مباشرة عامة (http/https):\n${bad.map((b) => `- ${b}`).join("\n")}`,
      isError: true,
    };
  }

  // 3) سجّل مهمة type=merge في Turso أولًا ثم أنشئها لدى الخدمة
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${collected.length} مقاطع`,
    params_json: JSON.stringify({ urls: collected, wait_seconds: args.wait_seconds ?? 60 }),
    status: "pending",
  });

  let jobId: string;
  try {
    jobId = (await mergerCreateJob(collected)).jobId;
  } catch (e) {
    // فشل معلن من خدمة الدمج = حتمي فوري (لا إعادة محاولة)
    const t = (await updateTask(taskId, { status: "failed", error_message: `فشل إنشاء مهمة الدمج: ${(e as Error).message}` }))!;
    return { task: t, message: formatTaskMessage(t), isError: true };
  }
  await updateTask(taskId, { provider_task_id: jobId, status: "processing", progress: 1 });

  // 4) أطلق process خلفيًا وبمرة واحدة فقط (محمي بقفل في الذاكرة)
  mergerLaunchProcess(jobId);

  // 5) نافذة الانتظار: استعلام كل 3 ثوانٍ + بث تقدم + تحديث القاعدة فورًا كل مرة
  const waitSeconds = Math.min(240, Math.max(0, Math.floor(args.wait_seconds ?? 60)));
  const deadline = Date.now() + waitSeconds * 1000;
  let lastNotify = 0;
  while (Date.now() < deadline) {
    const st = await mergerStatus(jobId);
    if (st.state === "completed" && st.videoUrl) {
      const t = (await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify([st.videoUrl]) }))!;
      return { task: t, message: formatTaskMessage(t) };
    }
    if (st.state === "failed" && st.definitive) {
      const t = (await updateTask(taskId, { status: "failed", error_message: st.error || "فشل الدمج" }))!;
      return { task: t, message: formatTaskMessage(t), isError: true };
    }
    const pct = Math.max(1, Math.min(95, st.progress ?? 5));
    await updateTask(taskId, { progress: pct });
    const now = Date.now();
    if (now - lastNotify >= PROGRESS_INTERVAL_MS) {
      lastNotify = now;
      await sendProgress(pct, `قيد الدمج… ${pct}%`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const t = (await getTask(taskId))!;
  return { task: t, message: formatTaskMessage(t) };
}

// refreshMergeTask: حدّث من GET /api/jobs/{id}؛ نفّذ process إن لم يُنفَّذ بعد؛ 404 → فشل نهائي
export async function refreshMergeTask(task: TaskRow): Promise<GenerationOutcome> {
  const jobId = task.provider_task_id;
  if (!jobId) {
    // فشل الإنشاء سابقًا — أعِد المحاولة من الروابط المخزنة في params
    const params = JSON.parse(task.params_json || "{}") as { urls?: string[] };
    if (params.urls?.length && mergerConfigured()) {
      try {
        const { jobId: jid } = await mergerCreateJob(params.urls);
        await updateTask(task.id, { provider_task_id: jid, status: "processing", progress: 1 });
        mergerLaunchProcess(jid);
        const t = (await getTask(task.id))!;
        return { task: t, message: formatTaskMessage(t) };
      } catch (e) {
        const t = (await updateTask(task.id, { status: "failed", error_message: `فشل إنشاء مهمة الدمج: ${(e as Error).message}` }))!;
        return { task: t, message: formatTaskMessage(t), isError: true };
      }
    }
    return { task, message: formatTaskMessage(task) };
  }

  const st: MergeStatusResult = await mergerStatus(jobId);
  if (st.state === "completed" && st.videoUrl) {
    const t = (await updateTask(task.id, { status: "completed", progress: 100, result_urls_json: JSON.stringify([st.videoUrl]) }))!;
    return { task: t, message: formatTaskMessage(t) };
  }
  if (st.state === "failed" && st.definitive) {
    const t = (await updateTask(task.id, { status: "failed", error_message: st.error || "فشل الدمج" }))!;
    return { task: t, message: formatTaskMessage(t), isError: true };
  }
  // إن كانت processing ولم يُنفَّذ process بعد (تقدم صفر وقفل الخلفية فارغ) فنفّذه الآن
  if (st.state === "processing" && !isProcessLaunched(jobId) && (st.progress ?? 0) <= 0) {
    void mergerProcessSync(jobId);
  }
  if ((st.progress ?? 0) > 0) {
    const t = (await updateTask(task.id, { progress: Math.max(1, Math.min(95, st.progress!)) }))!;
    return { task: t, message: formatTaskMessage(t) };
  }
  return { task, message: formatTaskMessage(task) };
}

// ---------- صياغة الردود (عربية) ----------
export function formatTaskMessage(task: TaskRow): string {
  const urls: string[] = task.result_urls_json ? JSON.parse(task.result_urls_json) : [];

  if (task.status === "completed") {
    if (task.type === "image") {
      const first = urls[0] || "";
      return `✅ تم توليد الصورة بنجاح\n\n![image](${first})\n\nالرابط المباشر: ${first}`;
    }
    if (task.type === "merge") {
      const list = urls.map((u) => `- الرابط المباشر: ${u}`).join("\n");
      return `✅ تم دمج المقاطع بنجاح\n\n${list}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
    }
    const list = urls.map((u) => `- الرابط المباشر: ${u}`).join("\n");
    return `✅ تم توليد الفيديو بنجاح\n\n${list}`;
  }

  if (task.status === "failed") {
    return `❌ فشلت المهمة: ${task.error_message || "سبب غير معروف"}`;
  }

  return `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}
