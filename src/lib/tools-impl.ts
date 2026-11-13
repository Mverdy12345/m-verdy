/* تنفيذات الأدوات: معلومات السيرفر + التعليمات الحرفية + list_media بالعربية */
import { MODELS } from "./models";
import { listRecentTasks } from "./turso";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

// نص التعليمات الرسمي — يُرسل مع initialize كما في المواصفة حرفيًا
export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

export async function listMediaArabic(
  type?: "image" | "video" | "merge",
  status?: "completed" | "failed" | "processing",
  limit = 10
): Promise<string> {
  const tasks = await listRecentTasks(limit, { type, status });
  if (!tasks.length) {
    const scope = [type && `النوع ${type}`, status && `الحالة ${status}`].filter(Boolean).join(" و");
    return `📂 لا توجد وسائط مخزنة ${scope ? `(${scope}) ` : ""}حتى الآن.`;
  }
  const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
  const STATUS_AR: Record<string, string> = {
    completed: "✅ مكتملة",
    failed: "❌ فاشلة",
    processing: "⏳ جارية",
    pending: "⏳ جارية",
  };
  const lines = tasks.map((t, i) => {
    const urls = t.result_urls_json ? (JSON.parse(t.result_urls_json) as string[]) : [];
    const head = `${i + 1}. [${TYPE_AR[t.type] || t.type}] ${STATUS_AR[t.status] || t.status} — ${t.model} — ${t.created_at}`;
    const prompt = t.prompt ? `\n   الوصف: ${t.prompt.slice(0, 90)}` : "";
    const links = urls.length ? `\n   الرابط: ${urls.join(" | ")}` : "";
    const tid = `\n   task_id: ${t.id}`;
    return head + prompt + links + tid;
  });
  return `📂 أحدث الوسائط المخزنة (${tasks.length}):\n\n${lines.join("\n\n")}`;
}
