/* واجهة المزودين الموحّدة — أي خطأ يُرمى كـ ProviderError {status, message} ليُصنَّف في errors.ts */
import type { MediaType } from "../models";
import type { KeyRow } from "../turso";
import { providerError, type ProviderError } from "../errors";

export interface ProviderInput {
  type: MediaType;
  providerModel: string;
  prompt: string;
  // معطيات الصورة
  aspect_ratio?: string;
  resolution?: string; // 1K/2K/4K للصور
  background?: string;
  output_format?: string;
  // معطيات الفيديو
  image_url?: string;
  enable_audio?: boolean;
  duration?: number; // 480p/720p/1080p للفيديو تُمرر في resolution أيضًا
}

export interface ProviderCheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // 0..100 تقديري
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId
  createTask(key: KeyRow, input: ProviderInput): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: KeyRow, input: ProviderInput): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: KeyRow, providerTaskId: string): Promise<ProviderCheckResult>;
}

export { providerError };
export type { ProviderError };

// نداء fetch موحّد مع مهلة ومعالجة أخطاء شبكة → ProviderError(0) مؤقتة
export async function fetchJson(
  url: string,
  init: RequestInit & { key?: string; timeoutMs?: number }
): Promise<{ status: number; body: unknown }> {
  const { key, timeoutMs = 120_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(rest.headers || {}),
      },
    });
  } catch {
    // انقطاع شبكة / timeout / abort — مؤقتة دائمًا
    throw providerError(0, "تعذر الوصول إلى مزود الخدمة (انقطاع شبكة أو مهلة)");
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: res.status, body };
}

// استخراج رسالة خطأ مقروءة من أي شكل استجابة معروف
export function extractErrorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "استجابة غير مفهومة من المزود";
  const b = body as Record<string, unknown>;
  for (const k of ["error", "message", "msg", "failMsg"]) {
    const v = b[k];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object") {
      const inner = v as Record<string, unknown>;
      if (typeof inner.message === "string") return inner.message;
    }
  }
  if (typeof b.raw === "string") return b.raw;
  return "خطأ من المزود بدون رسالة واضحة";
}
