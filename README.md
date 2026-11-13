# M Verdy — MCP Media Generator + خدمة دمج الفيديو

مستودع واحد بمشروعين جاهزين للنشر على Vercel:

| المشروع | المسار | الوصف |
|---|---|---|
| **MCP Media Generator** | جذر المستودع (`/`) | خادم MCP على `/mcp` بخمس أدوات (توليد صور، توليد فيديو، دمج مقاطع، تتبع المهام، استرجاع الوسائط) + لوحة إدارة عربية RTL |
| **خدمة دمج الفيديو** | `merger/` | موقع دمج فيديوهات + API عامة — Node خالص (بلا بناء) مع Turso Blobs وffmpeg |

> **روابط فقط:** لا يُنزَّل أي ملف وسائط على أيٍّ من السيرفرين إطلاقًا — تُخزَّن روابط النتائج في قاعدة Turso فقط.

---

## 1) MCP Media Generator (الجذر)

### الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` — تعيد رابطًا جاهزًا أو `task_id` |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` بصوت متزامن أصلي و image-to-video اختياري — يعيد `task_id` فورًا |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` (روابط مباشرة) أو `task_ids` (مهام مكتملة) — الناتج يُحذف من خدمة الدمج بعد ~24 ساعة |
| `get_task` | تتبع أي مهمة (توليد أو دمج) بمعرّفها — استعلم كل ~10 ثوانٍ حتى الاكتمال |
| `list_media` | أحدث الوسائط المخزنة بروابطها من قاعدة البيانات دون إعادة توليد |

### نظام المفاتيح المتسلسلة (قلب المشروع)

- تُجرَّب المفاتيح **بترتيب إضافتها الصارم** (`created_at ASC`) — أول مفتاح أُضيف يُجرَّب أولًا (ليس round-robin).
- عند أي خطأ أو نفاد رصيد: **تبديل فوري تلقائي** للمفتاح التالي مع **استئناف نفس المهمة بنفس `task_id`**.
- النموذج الذكي **لا يرى أخطاء المفاتيح أو الرصيد أبدًا** — التبديل صامت من وجهة نظره.
- مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (تهدئة 45 ثانية) — لو شُحن رصيد أي مفتاح تكتمل من تلقاء نفسها.
- المفتاح المستنزف يبقى في القاعدة بحالة `exhausted` ولا يُستبعد (الاستثناء الوحيد: التعطيل اليدوي).
- المفاتيح **مُقنَّعة دائمًا** في كل الاستجابات والسجلات (`ABCD123••••••••WXYZ`) وتُدار من واجهة الويب فقط.

### متغيرات البيئة

```bash
TURSO_DATABASE_URL=libsql://<db-name>-<org>.turso.io   # إلزامي
TURSO_AUTH_TOKEN=<Turso token>                          # إلزامي
MERGER_API_BASE=https://<merger-project>.vercel.app     # إلزامي — رابط خدمة الدمج المنشورة
MCP_ACCESS_TOKEN=                                       # اختياري: يحمي /mcp بـ Bearer
KIE_IMAGE_MODEL= / KIE_VIDEO_MODEL=                     # اختياري: تجاوز أسماء الموديلات
COMETAPI_IMAGE_MODEL= / COMETAPI_VIDEO_MODEL=
```

### الربط مع العملاء

- **ChatGPT:** Settings → Connectors → Create → Custom MCP server → ضع `https://<مشروعك>.vercel.app/mcp` في «Server URL».
- **Claude Desktop:** ملف `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "https://<مشروعك>.vercel.app/mcp"
    }
  }
}
```

- **Cursor / Windsurf / Cline:** نفس الصيغة في `mcp.json` (بدون `"type": "http"`).

### التشغيل محليًا

```bash
npm install
# انسخ .env.example إلى .env.local وضع القيم الحقيقية
npm run build && npm start      # إنتاج على المنفذ 3000
# أو
npm run dev                     # تطوير
```

### الاختبارات

```bash
npm run typecheck               # tsc --noEmit نظيف
npm run build                   # next build ينجح
# مع تشغيل خدمة الدمج محليًا (merger) وخادم الإنتاج:
node scripts/e2e-mcp.js 1       # health + مفاتيح + initialize + tools/list + صورة e2e + التبديل التسلسلي
node scripts/e2e-mcp.js 2       # فيديو e2e مع متابعة get_task
node scripts/e2e-mcp.js 3       # دمج e2e بمقطعين عامين + حالات الرفض
```

نتائج آخر تشغيل كامل: **المرحلة 1: 22/22 — المرحلة 2: 4/4 — المرحلة 3: 7/7** (توليد صورة وفيديو حقيقيان + دمج حقيقي + تبديل مفتاح خاطئ → تعطيل تلقائي واكتمال على المفتاح التالي بلا أي ذكر للمفاتيح للعميل).

---

## 2) خدمة دمج الفيديو (`merger/`)

Node.js خالص (CommonJS) بلا Next.js أو React أو أي خطوة بناء — كل الوسائط تُخزَّن **Blobs داخل Turso** مقسّمة صفوفًا 2MB، والدمج عبر `ffmpeg-static` داخل الدالة نفسها.

**التوثيق الكامل للـ API وخطوات النشر وحدود الخطة المجانية:** [`merger/README.md`](merger/README.md)

---

## 3) النشر على Vercel (مشروعان من نفس المستودع)

### أ) خدمة الدمج أولًا (لأن تطبيق MCP يحتاج رابطها)

1. Vercel → **Add New → Project** → استورد `Mverdy12345/m-verdy`.
2. **Root Directory** = `merger`.
3. Framework Preset = Other (تلقائي).
4. أضف متغيري البيئة: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (نفس قاعدة Turso).
5. Deploy — انسخ الرابط مثل `https://m-verdy-merger.vercel.app`.

### ب) تطبيق MCP

1. Vercel → **Add New → Project** → استورد نفس المستودع مرة ثانية.
2. **Root Directory** = الفارغ (الجذر).
3. أضف المتغيرات: `TURSO_DATABASE_URL`، `TURSO_AUTH_TOKEN`، و `MERGER_API_BASE` = رابط مشروع الدمج من الخطوة (أ).
4. Deploy — انسخ الرابط وضعه في عملاء MCP.

> الروابط المباشرة:
> [نشر خدمة الدمج](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMverdy12345%2Fm-verdy&rootDirectory=merger&env=TURSO_DATABASE_URL,TURSO_AUTH_TOKEN&project-name=m-verdy-merger) ·
> [نشر تطبيق MCP](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMverdy12345%2Fm-verdy&env=TURSO_DATABASE_URL,TURSO_AUTH_TOKEN,MERGER_API_BASE&project-name=m-verdy-mcp)

### إنشاء قاعدة Turso (مرة واحدة)

```bash
turso db create verdy-mverdy
turso db show verdy-mverdy --url          # ← TURSO_DATABASE_URL
turso db tokens create verdy-mverdy       # ← TURSO_AUTH_TOKEN
```

الجداول تُنشأ تلقائيًا عند أول وصول (`CREATE TABLE IF NOT EXISTS`) — لا حاجة لأي أداة migrations.

---

## 4) الأمان

- `.env*` مستثناة في `.gitignore` منذ أول commit — لا أسرار في المستودع إطلاقًا.
- مفاتيح API للمزودين تُخزَّن في قاعدة Turso فقط، وتُدار من واجهة الويب، ولا تُعاد كاملة في أي استجابة (إخفاء إلزامي).
- إن أردت حماية `/mcp`: اضبط `MCP_ACCESS_TOKEN` في Vercel وأضف ترويسة `Authorization: Bearer <token>` في إعدادات العميل.

## بنية المستودع

```
├── src/
│   ├── app/mcp/route.ts            # خادم MCP (SDK الرسمي + النقل القياسي، وضع لاأفاني)
│   ├── app/api/{health,keys,tasks} # واجهات اللوحة
│   ├── app/page.tsx + layout.tsx   # اللوحة العربية RTL
│   └── lib/                        # turso / models / errors / keys / orchestrator / merger / mcp-server
├── merger/                          # خدمة الدمج المستقلة (api/ + lib/ + public/ + scripts/)
├── scripts/e2e-mcp.js               # اختبارات e2e الثلاث مراحل
├── .env.example
└── README.md
```
