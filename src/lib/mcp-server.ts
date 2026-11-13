/* مصنع خادم MCP — الأدوات الخمس بمخططات المواصفة الحرفية.
   نتيجة الاستدعاءات تُصاغ بالعربية؛ الأوصاف الإنجليزية للعميل. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runGeneration, runMerge, refreshTask } from "./orchestrator";
import { listMediaArabic, SERVER_INFO, SERVER_INSTRUCTIONS } from "./tools-impl";

export { SERVER_INFO, SERVER_INSTRUCTIONS };

export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
  });

  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active API keys). " +
        "Returns a ready image URL if completed within the wait window; otherwise returns a task_id — " +
        "call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => runGenerationWrapped(args, "image", extra)
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio — dialogue/effects/music, optional image-to-video). " +
        "Video takes minutes: short wait with live progress, then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => runGenerationWrapped(args, "video", extra)
  );

  // 3) merge_videos — بلا resolution/fps وبحد 10 (خدمة الدمج تثبّت المخرج)
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video links — e.g. from generate_video) " +
        "or 'task_ids' (completed video tasks resolved from the database in this order — ideal after generating several clips). " +
        "Merging is usually quick: short wait with live progress, then a merge task_id — track it with get_task. " +
        "Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2, { message: "الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2, { message: "الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." })
          .max(10, { message: "أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." })
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const progress = progressSender(extra);
      const outcome = await runMerge({
        urls: (args as { urls?: string[] }).urls,
        task_ids: (args as { task_ids?: string[] }).task_ids,
        wait_seconds: (args as { wait_seconds?: number }).wait_seconds,
        sendProgress: progress,
      });
      return textResult(outcome.message, outcome.isError);
    }
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its id — image/video generation AND merging (reads Turso and live-updates from the provider/service while processing). " +
        "Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().describe("The task_id returned by generate_image / generate_video / merge_videos."),
      },
    },
    async (args) => {
      const outcome = await refreshTask((args as { task_id: string }).task_id);
      return textResult(outcome.message, outcome.isError);
    }
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Recent images/videos/merges stored with their links from the database (no regeneration) — to recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const a = args as { type?: "image" | "video" | "merge"; status?: "completed" | "failed" | "processing"; limit?: number };
      const message = await listMediaArabic(a.type, a.status, a.limit ?? 10);
      return textResult(message);
    }
  );

  return server;
}

// ---------- أدوات مساعدة ----------
type ToolExtra = {
  _meta?: Record<string, unknown>;
  requestInfo?: { _meta?: Record<string, unknown>; headers?: unknown };
  sendNotification: (n: unknown) => Promise<void>;
};

// إرسال progress notifications أثناء نافذة الانتظار إذا زوّد العميل الطلب بـ _meta.progressToken
function progressSender(extra: unknown): (percent: number, message: string) => Promise<void> {
  const x = extra as ToolExtra | undefined;
  const token =
    x?.requestInfo?._meta && typeof (x.requestInfo._meta as Record<string, unknown>).progressToken !== "undefined"
      ? (x.requestInfo._meta as Record<string, unknown>).progressToken
      : x?._meta && typeof (x._meta as Record<string, unknown>).progressToken !== "undefined"
        ? (x._meta as Record<string, unknown>).progressToken
        : undefined;
  if (token === undefined || !x?.sendNotification) return async () => {};
  return async (percent: number, message: string) => {
    try {
      await x.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: Math.min(99, Math.max(0, percent)), total: 100, message },
      });
    } catch {
      // إشعار التقدم اختياري — لا نكسر التوليد بسببه
    }
  };
}

async function runGenerationWrapped(
  rawArgs: unknown,
  type: "image" | "video",
  extra: unknown
): Promise<CallToolResult> {
  const args = rawArgs as Record<string, unknown>;
  const progress = progressSender(extra);
  const outcome = await runGeneration({ ...(args as object), type, sendProgress: progress } as never);
  return textResult(outcome.message, outcome.isError);
}

function textResult(text: string, isError?: boolean): CallToolResult {
  const res: CallToolResult = {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
  return res;
}
