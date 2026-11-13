/* نظام المفاتيح المتسلسلة — قلب المشروع: الترتيب الصارم + إخفاء المفاتيح + عدّادات */
import type { ProviderId } from "./models";
import { getDb, ensureSchema, type KeyRow } from "./turso";
import { classifyProviderError } from "./errors";

// الإخفاء إلزامي في كل الاستجابات والسجلات — لا يُعاد المفتاح الكامل أبدًا
export function maskKey(key: string): string {
  if (key.length <= 10) return key.slice(0, 3) + "••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

// أول مفتاح أُضيف يُجرَّب أولًا (created_at ASC, id ASC) — ترتيب تسلسلي مقصود، ليس round-robin.
// المستنزف (exhausted) يبقى في القائمة والقاعدة؛ الاستثناء الوحيد هو التعطيل اليدوي (disabled).
export async function getKeyPool(providers: ProviderId[]): Promise<KeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const r = await getDb().execute({
    sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return r.rows.map((x) => x as unknown as KeyRow);
}

export interface KeyBump {
  ok: boolean;
  error?: string;
  status?: number; // حالة HTTP من المزود للتصنيف
}

// عدّادات المفتاح تُحدَّث دائمًا مع كل استخدام (نجاح أو فشل + الفئة)
export async function bumpKey(id: string, bump: KeyBump): Promise<void> {
  await ensureSchema();
  if (bump.ok) {
    await getDb().execute({
      sql: `UPDATE api_keys
            SET usage_count = usage_count + 1, success_count = success_count + 1,
                last_used_at = datetime('now'), last_checked_at = datetime('now'), last_error = NULL
            WHERE id = ?`,
      args: [id],
    });
    return;
  }
  const cls = bump.status !== undefined ? classifyProviderError(bump.status, bump.error || "") : "temporary";
  const newStatus = cls === "disabled" ? "disabled" : cls === "exhausted" ? "exhausted" : "active";
  await getDb().execute({
    sql: `UPDATE api_keys
          SET usage_count = usage_count + 1, fail_count = fail_count + 1,
              last_used_at = datetime('now'), last_checked_at = datetime('now'), last_error = ?, status = ?
          WHERE id = ?`,
    args: [(bump.error || "خطأ غير معروف").slice(0, 500), newStatus, id],
  });
}

// رسالة عدم وجود مفاتيح — عرضها للعميل مسموح (لا تتضمن أي سر)
export function noKeysMessage(modelCanonical: string): string {
  return `❌ لا توجد مفاتيح نشطة لخدمة ${modelCanonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;
}
