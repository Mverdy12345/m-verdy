/* مزود kie.ai — Jobs API الموحد (الأشكال المقاسة فعليًا بنداءات حقيقية، مطابقة للمواصفة):
   POST /api/v1/jobs/createTask → {"code":200,"data":{"taskId":"..."}}
   GET  /api/v1/jobs/recordInfo?taskId → data.state + resultJson (نص JSON يحتاج JSON.parse ثانيًا) */
import { fetchJson, extractErrorMessage, providerError, type ProviderAdapter, type ProviderInput, type ProviderCheckResult } from "./types";
import type { KeyRow } from "../turso";

const BASE = "https://api.kie.ai";

// بناء input حسب نوع المهمة — لا نرسل حقولًا مختلقة
function buildInput(input: ProviderInput): Record<string, unknown> {
  if (input.type === "image") {
    const i: Record<string, unknown> = { prompt: input.prompt };
    if (input.aspect_ratio && input.aspect_ratio !== "auto") i.aspect_ratio = input.aspect_ratio;
    if (input.resolution && input.resolution !== "auto") i.resolution = input.resolution;
    if (input.background && input.background !== "auto") i.background = input.background;
    if (input.output_format) i.output_format = input.output_format;
    return i;
  }
  const i: Record<string, unknown> = { prompt: input.prompt };
  if (input.image_url) i.image_url = input.image_url;
  if (input.aspect_ratio && input.aspect_ratio !== "auto") i.aspect_ratio = input.aspect_ratio;
  if (input.resolution && input.resolution !== "auto") i.resolution = input.resolution;
  i.enable_audio = input.enable_audio ?? true;
  if (input.duration) i.duration = input.duration;
  return i;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: KeyRow, input: ProviderInput) {
    const { status, body } = await fetchJson(`${BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      key: key.api_key,
      body: JSON.stringify({ model: input.providerModel, input: buildInput(input) }),
    });
    const b = body as Record<string, unknown>;
    const code = Number(b?.code);
    if (status >= 400 || (Number.isFinite(code) && code !== 200) || !b?.data) {
      throw providerError(status || 500, extractErrorMessage(body));
    }
    const data = b.data as Record<string, unknown>;
    const taskId = String(data.taskId || data.task_id || "");
    if (!taskId) throw providerError(500, "استجابة المزود لا تحتوي معرّف مهمة");
    return { providerTaskId: taskId };
  },

  async checkTask(key: KeyRow, providerTaskId: string): Promise<ProviderCheckResult> {
    const { status, body } = await fetchJson(`${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      key: key.api_key,
      timeoutMs: 30_000,
    });
    if (status >= 400) throw providerError(status, extractErrorMessage(body));
    const b = body as Record<string, unknown>;
    const data = (b?.data ?? b) as Record<string, unknown> | undefined;
    if (!data) throw providerError(500, "استجابة استعلام المهمة غير مفهومة");

    const state = String(data.state || "").toLowerCase();
    // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثانيًا
    let urls: string[] | undefined;
    if (typeof data.resultJson === "string" && data.resultJson) {
      try {
        const parsed = JSON.parse(data.resultJson) as Record<string, unknown>;
        const arr = parsed.resultUrls;
        if (Array.isArray(arr)) urls = arr.filter((u): u is string => typeof u === "string" && u.length > 0);
      } catch {
        // الشكل تغيّر؟ نتجاهل بلا انهيار
      }
    }

    if (state === "success") {
      if (!urls || !urls.length) {
        // نجاح بلا روابط = فشل فعلي
        return { status: "failed", error: String(data.failMsg || "اكتملت المهمة لدى المزود دون روابط نتائج") };
      }
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail" || state === "failed") {
      return { status: "failed", error: String(data.failMsg || "فشل التوليد لدى المزود") };
    }
    // تقدير تقدم من الحالة (المزود لا يرسل نسبة)
    const progress = state === "generating" ? 45 : state === "queuing" ? 15 : 5;
    return { status: "processing", progress };
  },
};
