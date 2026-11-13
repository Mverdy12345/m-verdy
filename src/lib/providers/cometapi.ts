/* مزود CometAPI — صور متزامنة عبر نقطة images المتوافقة مع OpenAI، وفيديو عبر نقطة المهام
   غير المتزامنة (نمط /v1/videos المعتمد في توثيقهم المفتوح المتوافق مع OpenAI).
   ملاحظة: المزود الأساسي المُختبَر فعليًا هو kie.ai — كي يُستخدم CometAPI يجب إضافة مفتاح له
   من واجهة الإدارة، وأي انحراف في أشكال الاستجابة يُصنَّف آمنًا ويعود للمفتاح التالي. */
import { fetchJson, extractErrorMessage, providerError, type ProviderAdapter, type ProviderInput, type ProviderCheckResult } from "./types";
import type { KeyRow } from "../turso";

const BASE = (process.env.COMETAPI_BASE_URL || "https://api.cometapi.com").replace(/\/+$/, "");

export const cometapiAdapter: ProviderAdapter = {
  // صور متزامنة: تعيد الرابط فورًا
  async createImageSync(key: KeyRow, input: ProviderInput) {
    const { status, body } = await fetchJson(`${BASE}/v1/images/generations`, {
      method: "POST",
      key: key.api_key,
      body: JSON.stringify({
        model: input.providerModel,
        prompt: input.prompt,
        n: 1,
        response_format: "url",
      }),
    });
    if (status >= 400) throw providerError(status, extractErrorMessage(body));
    const b = body as Record<string, unknown>;
    const data = (b?.data ?? b) as Record<string, unknown> | undefined;
    const first = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
    const url = first?.url;
    if (typeof url === "string" && url.startsWith("http")) return { urls: [url] };
    if (first?.b64_json) {
      // قاعدتنا: روابط فقط — لا نحتفظ ببيانات ثنائية، فنتجاوز هذا المفتاح لصالح التالي
      throw providerError(400, "المزود أعاد الصورة كبيانات بدل رابط مباشر");
    }
    throw providerError(500, "لم يُعثر على رابط الصورة في استجابة المزود");
  },

  // فيديو غير متزامن
  async createTask(key: KeyRow, input: ProviderInput) {
    const bodyReq: Record<string, unknown> = { model: input.providerModel, prompt: input.prompt };
    if (input.image_url) bodyReq.image_url = input.image_url;
    if (input.aspect_ratio && input.aspect_ratio !== "auto") bodyReq.aspect_ratio = input.aspect_ratio;
    if (input.resolution && input.resolution !== "auto") bodyReq.resolution = input.resolution;
    bodyReq.enable_audio = input.enable_audio ?? true;
    if (input.duration) bodyReq.duration = input.duration;

    const { status, body } = await fetchJson(`${BASE}/v1/videos`, {
      method: "POST",
      key: key.api_key,
      body: JSON.stringify(bodyReq),
    });
    if (status >= 400) throw providerError(status, extractErrorMessage(body));
    const b = body as Record<string, unknown>;
    const id =
      (b?.id as string) ||
      (b?.taskId as string) ||
      ((b?.data as Record<string, unknown>)?.id as string) ||
      ((b?.data as Record<string, unknown>)?.taskId as string);
    if (!id) throw providerError(500, "استجابة إنشاء الفيديو لا تحتوي معرّف مهمة");
    return { providerTaskId: String(id) };
  },

  async checkTask(key: KeyRow, providerTaskId: string): Promise<ProviderCheckResult> {
    const { status, body } = await fetchJson(`${BASE}/v1/videos/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      key: key.api_key,
      timeoutMs: 30_000,
    });
    if (status >= 400) throw providerError(status, extractErrorMessage(body));
    const b = body as Record<string, unknown>;
    const rawStatus = String(b?.status || (b?.data as Record<string, unknown>)?.status || "").toLowerCase();
    // استخراج دفاعي للرابط من عدة أشكال محتملة
    const candidates = [b?.url, b?.video_url, (b?.data as Record<string, unknown>)?.url, (b?.data as Record<string, unknown>)?.video_url, b?.download_url];
    const urls = candidates.filter((u): u is string => typeof u === "string" && u.startsWith("http"));

    if (["completed", "succeeded", "success", "done"].includes(rawStatus)) {
      if (!urls.length) return { status: "failed", error: "اكتمل الفيديو لدى المزود دون رابط نتائج" };
      return { status: "completed", urls, progress: 100 };
    }
    if (["failed", "error", "cancelled"].includes(rawStatus)) {
      return { status: "failed", error: extractErrorMessage(body) };
    }
    return { status: "processing", progress: rawStatus === "processing" || rawStatus === "in_progress" ? 45 : 10 };
  },
};
