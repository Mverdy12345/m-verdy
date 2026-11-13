/* GET /api/health — الجهوزية الكاملة: قاعدة البيانات + الموديلات + خدمة الدمج + التوثيق */
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerBase, mergerHealthy, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ok = await dbHealthy();
  const mergerHealthyFlag = await mergerHealthy();
  return NextResponse.json({
    ok,
    database: ok ? "turso-connected" : "turso-disconnected",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: mergerConfigured() ? mergerBase() : "(غير مضبوط)", healthy: mergerHealthyFlag },
    authRequired: !!process.env.MCP_ACCESS_TOKEN,
  });
}
