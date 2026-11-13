/* مسار /mcp — خادم MCP عبر Streamable HTTP باستخدام SDK الرسمي.
   نستخدم WebStandardStreamableHTTPServerTransport (Request/Response القياسية) — الأنسب لـ
   Next.js App Router وVercel. الوضع لاأفاني (sessionIdGenerator: undefined): كل طلب بنقل
   مستقل جديد (النقل اللاأفاني لا يُعاد استخدامه) — لا جلسات عالقة بين نُسخ الدوال البرمجية
   على Vercel، ويعمل مع كل العملاء (ChatGPT / Claude / Cursor / Cline). */
import { createMcpServer } from "@/lib/mcp-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// مهلة الدالة — رافعات الانتظار داخل أدوات التوليد أقل من ذلك بكثير
export const maxDuration = 300;

const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN;

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "مطلوب توثيق: Authorization: Bearer <MCP_ACCESS_TOKEN>" }),
    { status: 401, headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
}

async function handle(req: Request): Promise<Response> {
  // توثيق اختياري — إن ضُبط MCP_ACCESS_TOKEN يُطلب Bearer token على /mcp
  if (MCP_ACCESS_TOKEN) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${MCP_ACCESS_TOKEN}`) return unauthorized();
  }

  // نقل جديد لكل طلب + خادم جديد لكل طلب (إلزامي في الوضع اللاأفاني)
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    keepAliveMs: 0, // بلا مؤقّتات خلفية — لا تسريبات في بيئة serverless
  });
  await server.connect(transport);

  // إلغاء العميل يغلق النقل فورًا
  const abort = () => transport.close().catch(() => {});
  if (req.signal) {
    if (req.signal.aborted) abort();
    else req.signal.addEventListener("abort", abort, { once: true });
  }

  try {
    return await transport.handleRequest(req);
  } catch (e) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: `خطأ داخلي في خادم MCP: ${(e as Error).message}` },
        id: null,
      }),
      { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}

// GET (فتح مجرى SSE مستقل) وDELETE (إنهاء جلسة) — بلا جلسات في الوضع اللاأفاني
// يعيد النقل نفسه الاستجابة الصحيحة (405/404) حسب مواصفة MCP
export async function GET(req: Request) {
  return handle(req);
}

export async function DELETE(req: Request) {
  return handle(req);
}
