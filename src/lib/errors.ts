/* تصنيف أخطاء المزودين — الجدول 4.2 في المواصفة. يُفحص نفاد الرصيد قبل 400
   لأن بعض المزودين يرسلون نفاد الرصيد بحالة 400 */

export type ProviderErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export interface ProviderError extends Error {
  status: number; // 0 = خطأ شبكة/انقطاع
}

export function providerError(status: number, message: string): ProviderError {
  const e = new Error(message) as ProviderError;
  e.status = status;
  return e;
}

// رسالة فشل منتصف مهمة تُشير لمشكلة مفتاح/رصيد → نعيد الإنشاء على المفتاح التالي (قسم 4.3.2)
const KEY_FAIL_RE = /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|充值/i;

export function looksLikeKeyFailure(message: string): boolean {
  return KEY_FAIL_RE.test(message || "");
}

export function classifyProviderError(status: number, message: string): ProviderErrorClass {
  const m = (message || "").toLowerCase();

  // 1) نفاد الرصيد — قبل فحص 400 (بعض المزودين يرسلونه بحالة 400)
  if (status === 402 || /insufficient|quota|balance|credit|out of credits|exhausted|充值/.test(m)) {
    return "exhausted";
  }
  // 2) مفتاح مرفوض
  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden|authentication/.test(m)) {
    return "disabled";
  }
  // 3) الموديل غير مدعوم لدى هذا المزود
  if (
    (status === 400 || status === 404 || status === 422) &&
    /model not found|unsupported model|not a valid model|unknown model/.test(m)
  ) {
    return "provider";
  }
  // 4) معطيات الطلب — تبديل المفاتيح لن يحل خطأ معطيات
  if (status === 400 || status === 422) {
    return "params";
  }
  // 5) 429 / 5xx / انقطاع شبكة / timeout / abort — وأي غير مصنّف احتياطًا
  return "temporary";
}
