# خدمة دمج الفيديوهات — Video Merger API v2

موقع كامل لدمج الفيديوهات مع واجهة API عامة للمطورين — Node.js خالص (CommonJS) بلا أي خطوة بناء، جاهز للنشر على Vercel، والتخزين كله داخل **Turso (libSQL)**: بيانات المهام، أجزاء الملفات المرفوعة، والفيديو الناتج (Blobs). لا S3 ولا خدمات خارجية.

- **واجهة عربية RTL بثيم داكن** (تدرجات سماوي/بنفسجي): إضافة روابط + سحب وإفلات لرفع الملفات + إعادة ترتيب المصادر بالسحب أو أسهم ↑↓ + شريط تقدم حقيقي + صفحة نتيجة بمشغل وعدّاد تنازلي 24 ساعة + توثيق API قابل للطي داخل الصفحة.
- **جودة إلزامية:** libx264 **CRF 18** + AAC 192k/44100Hz + `+faststart` — MP4 يعمل فورًا على الويب حتى 1080p.
- **حذف تلقائي بعد 24 ساعة** لكل شيء (تنظيف كسول عند كل طلب + Cron يومي).

## الحدود

| الحد | القيمة | متغير البيئة |
|---|---|---|
| عدد المقاطع | 10 كحد أقصى | `MAX_SOURCES` |
| حجم كل مصدر | 200MB | `SOURCE_MAX_MB` |
| حجم الناتج | 150MB | `OUTPUT_MAX_MB` |
| مجموع المدد | 600 ثانية | `MAX_TOTAL_DURATION_SEC` |
| حجم جزء الرفع | 4MB (حد الطلب في Vercel ≈ 4.5MB) | ثابت |
| صفوف Blobs في Turso | 2MB | ثابت |
| الـ preset للترميز | medium | `FFMPEG_PRESET` |
| الصلاحية | 24 ساعة | ثابت |

## متغيرات البيئة (إلزامية)

```bash
TURSO_DATABASE_URL=libsql://<db-name>-<org>.turso.io
TURSO_AUTH_TOKEN=<Turso token بصلاحيات كتابة>
# اختيارية: MAX_SOURCES / SOURCE_MAX_MB / OUTPUT_MAX_MB / MAX_TOTAL_DURATION_SEC / FFMPEG_PRESET
```

## التوثيق الكامل للـ API

الأخطاء دائمًا بصيغة `{"error":"رسالة عربية"}` — الرموز: 400 مدخلات تالفة، 404 غير موجود، 409 حالة غير مناسبة، 413 تجاوز الحجم، 405 طريقة خاطئة. CORS مفتوح وبلا تسجيل دخول.

### `POST /api/jobs` — إنشاء مهمة دمج

```bash
curl -X POST https://<domain>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/clip1.mp4","https://example.com/clip2.mp4"]}'
```

استجابة `201`:

```json
{
  "jobId": "wkucdefoxwvd",
  "status": "queued",
  "statusUrl": "https://<domain>/api/jobs/wkucdefoxwvd",
  "processUrl": "https://<domain>/api/jobs/wkucdefoxwvd/process",
  "expiresAt": "2026-11-14 14:30:00"
}
```

يقبل أيضًا مصادر ملفات `{"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}` — وإن وُجدت ملفات ترجع حالة `uploading` مع `uploads[]` برابط رفع لكل مصدر + `uploadChunkBytes`.

### `POST /api/upload?job=<id>&seq=<n>&chunk=<k>` — رفع أجزاء الملفات

ثنائي صافٍ ≤4MB (Content-Type: `application/octet-stream`) — أعد المحاولة تلقائيًا عند الفشل (الجزء k يشغل صفوف Blobs محددة بالضبط، فإعادة الرفع تستبدلها بلا تكرار):

```bash
curl -X POST "https://<domain>/api/upload?job=<id>&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @part0.bin
```

استجابة: `{"ok":true,"job":"...","seq":1,"chunk":0,"received":...,"uploadedBytes":...,"totalBytes":...,"done":false}`

### `POST /api/jobs/<id>/process` — تنفيذ الدمج (متزامن)

ينزّل/يسحب المصادر ← يوحّد كل شيء عبر filter_complex (scale+pad إلى أكبر دقة، حد 1920×1080 بأبعاد زوجية، fps=30، yuv420p) ← مصدر بلا صوت يُضاف له مسار صامت anullsrc بنفس مدته ← يرمّز ← يخزّن الناتج Blobs في Turso. تقدم الخادم يُكتب في القاعدة (0–40 سحب، 40–90 ترميز، 100 اكتمال).

```bash
curl -X POST https://<domain>/api/jobs/<id>/process
```

نجاح `200`:

```json
{
  "status": "done",
  "videoUrl": "https://<domain>/api/jobs/<id>/video",
  "downloadUrl": "https://<domain>/api/jobs/<id>/video?download=1",
  "size": 2958048,
  "duration": 25.03,
  "resolution": "640x360",
  "expiresAt": "2026-11-14 14:30:00"
}
```

لو المهمة قيد المعالجة فعله يرجع `202`. أي خطأ HTTP معلن (4xx/5xx بجسم error) = **فشل نهائي فوري** — لا إعادة محاولة.

### `GET /api/jobs/<id>` — الحالة والتقدم

```bash
curl https://<domain>/api/jobs/<id>
```

`{"jobId","status":"queued|uploading|processing|done|failed","progress":0..100,"videoUrl","downloadUrl","size","duration","resolution","expiresAt","error"}`

### `GET /api/jobs/<id>/video` — بث الناتج بدعم Range

استجابة `206` + `Content-Range` للتقديم/الترجيع، و `?download=1` للتحميل المباشر. البث يجري صفحات من 8 صفوف Blobs مع تقليم أول/آخر جزء حسب المدى المطلوب.

```bash
curl -H "Range: bytes=0-1023" -o chunk.mp4 https://<domain>/api/jobs/<id>/video
curl -o merged.mp4 "https://<domain>/api/jobs/<id>/video?download=1"
```

### `DELETE /api/jobs/<id>` — حذف فوري شامل

يحذف كل صفوف المهمة (jobs + sources + source_chunks + output_chunks) دفعة واحدة:

```bash
curl -X DELETE https://<domain>/api/jobs/<id>
```

### `GET /api/config` — الحدود العامة + version

```bash
curl https://<domain>/api/config
```

### `GET /api/cron` — حذف المهام المنتهية

مجدولة يوميًا 03:00 UTC عبر `vercel.json` (crons)، وتعمل أيضًا كسلوك تنظيف كسول عند الإنشاء/الدمج.

## النشر على Vercel خطوة بخطوة

1. **أنشئ قاعدة Turso** (إن لم تكن جاهزة):
   ```bash
   turso db create verdy-mverdy
   turso db show verdy-mverdy --url       # انسخ الرابط → TURSO_DATABASE_URL
   turso db tokens create verdy-mverdy    # أنشئ توكن كتابة → TURSO_AUTH_TOKEN
   ```
2. **اربط المستودع بـ Vercel:** Add New → Project → استورد `Mverdy12345/m-verdy` → **Root Directory** = `merger` → Framework = Other.
3. **أين أضع متغيري Turso؟** في إعدادات المشروع: Settings → Environment Variables → أضف `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (Production + Preview) → Deploy.
4. **جرّب الـ API بـ curl بعد النشر:**
   ```bash
   curl https://<your-domain>/api/config
   curl -X POST https://<your-domain>/api/jobs -H "Content-Type: application/json" \
     -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
   curl -X POST https://<your-domain>/api/jobs/<jobId>/process
   curl https://<your-domain>/api/jobs/<jobId>
   curl -o merged.mp4 https://<your-domain>/api/jobs/<jobId>/video
   ```
5. ضع رابط هذه الخدمة في متغير `MERGER_API_BASE` داخل مشروع تطبيق MCP (الجذر).

## التشغيل والاختبار محليًا

```bash
npm install
cp .env.example .env    # وضع القيم الحقيقية — ملف .env مستثنى من Git
npm start               # خادم تطوير يحاكي Vercel (يحل المسارات الديناميكية ويضعها في req.query)
npm run test:unit       # اختبار وحدات: توليد مقطعين مختلفي الدقة → دمج → الدقة/المدة/الصوت + Turso Blobs sha256 + رفع الأجزاء + الحدود + الحذف
npm run test:http       # اختبار HTTP كامل: روابط → دمج → Range 206 → مهمة مختلطة → حذف → 404 → JSON تالف → حدود
```

آخر تشغيل: **وحدات 17/17 ناجح — HTTP 20/20 ناجح**.

## حدود الخطة المجانية التي يجب معرفتها

| الحد | القيمة على Vercel Hobby | التأثير هنا |
|---|---|---|
| مدة الدالة | حتى 300 ثانية (Fluid Compute) | كافية للدمج النموذجي (10–60 ثانية)؛ المقاطع الكبيرة جدًا قد تقترب من المهلة |
| حجم الطلب | ≈ 4.5MB | سبب رفع الملفات أجزاءً 4MB بإعادة محاولة ×3 |
| حجم قاعدة Turso المجانية | 500MB | الناتج ≤150MB + حذف تلقائي بعد 24 ساعة يبقي الاستخدام منخفضًا |
| reads/writes المجانية | كافية للاستخدام الشخصي | كل استطلاع حالة يقرأ صفًّا واحدًا فقط |
| بلا نظام ملفات دائم | `/tmp` فقط أثناء المعالجة | يُنظَّف في `finally` بعد كل عملية |

## نقاط حرجة (منفَّذة)

- Rفع الملفات أجزاء POST ثنائية 4MB مع إعادة محاولة ×3.
- بث الفيديو يدعم Range (استجابة 206 + Content-Range) — التقديم/الترجيع يعملان في المشغل.
- `vercel.json`: `maxDuration: 300` لكل الدوال + Cron يومي.
- لا نظام ملفات دائم — `/tmp` فقط أثناء المعالجة ويُنظَّف في `finally`.
- كل Blob يُقسَّم صفوفًا 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات من 8 صفوف.
- بعد نجاح الدمج تُحذف `source_chunks` — الناتج فقط هو المطلوب.
- ثنائي ffmpeg قد يفقد صلاحية التنفيذ: `ensureExecutable` تنسخه إلى `/tmp` بصلاحية 755 عند الحاجة.
