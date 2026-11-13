/* GET /api/tasks — أحدث المهام + الإحصائيات (تُحدّث لوحة الواجهة كل ~5 ثوانٍ) */
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || 20));
  const type = sp.get("type") || undefined;
  const status = sp.get("status") || undefined;

  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, { type, status }),
    taskStats(),
  ]);

  return NextResponse.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id,
      provider: t.provider,
      model: t.model,
      type: t.type,
      prompt: t.prompt.slice(0, 140),
      status: t.status,
      progress: t.progress,
      result_urls: t.result_urls_json ? (JSON.parse(t.result_urls_json) as string[]) : [],
      error: t.error_message,
      attempts: (JSON.parse(t.attempts_json || "[]") as unknown[]).length,
      created_at: t.created_at,
      completed_at: t.completed_at,
    })),
  });
}
