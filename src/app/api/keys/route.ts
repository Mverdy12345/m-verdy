/* /api/keys — إدارة المفاتيح للواجهة: القائمة مُقنَّعة دائمًا + إضافة مع رفض التكرار */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listKeys, insertKey, type KeyRow } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS = ["kie", "cometapi"];

function masked(k: KeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    masked: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}

export async function GET() {
  const keys = await listKeys();
  // الإخفاء إلزامي — لا يُعاد المفتاح الكامل في أي استجابة
  return NextResponse.json({ keys: keys.map(masked) });
}

export async function POST(req: NextRequest) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "صيغة JSON غير صالحة" }, { status: 400 });
  }
  const provider = (body.provider || "").trim();
  const apiKey = (body.api_key || "").trim();
  const label = (body.label || "").trim().slice(0, 60);
  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey || apiKey.length < 8) {
    return NextResponse.json({ error: "أدخل مفتاح API صالحًا (8 أحرف على الأقل)" }, { status: 400 });
  }
  const keys = await listKeys();
  if (keys.some((k) => k.provider === provider && k.api_key === apiKey)) {
    return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود — رفض التكرار" }, { status: 409 });
  }
  const id = randomUUID();
  await insertKey({ id, provider, label, api_key: apiKey });
  const created = keys.length; // للترتيب التسلسلي: أول مفتاح أُضيف يُجرَّب أولًا
  return NextResponse.json({ ok: true, id, order: created, masked: maskKey(apiKey) }, { status: 201 });
}
