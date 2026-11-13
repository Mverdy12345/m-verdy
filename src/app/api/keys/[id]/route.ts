/* /api/keys/[id] — تعطيل/تنشيط يدوي + حذف */
import { NextRequest, NextResponse } from "next/server";
import { getKey, setKeyStatus, deleteKey } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "صيغة JSON غير صالحة" }, { status: 400 });
  }
  const status = (body.status || "").trim();
  if (!["active", "disabled"].includes(status)) {
    return NextResponse.json({ error: "الحالة المسموحة: active أو disabled" }, { status: 400 });
  }
  const key = await getKey(id);
  if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await setKeyStatus(id, status);
  return NextResponse.json({ ok: true, id, status, masked: maskKey(key.api_key) });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const key = await getKey(id);
  if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteKey(id);
  return NextResponse.json({ ok: true, id });
}
