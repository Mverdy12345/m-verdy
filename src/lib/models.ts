/* سجل الموديلات: الاسم الموحّد + الصيغ البديلة + المزودون القادرون على خدمته + اسم الموديل لكل مزود */

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

function envOr(name: string, def: string): string {
  const v = (process.env[name] || "").trim();
  return v || def;
}

// الموديلان المدمجان — مثبّتان كما هما في المواصفة، وقابلان للتجاوز بمتغيرات البيئة
export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2-6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOr("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image"),
      cometapi: envOr("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image"),
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview", "grok-imagine-video-1-5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOr("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
      cometapi: envOr("COMETAPI_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
    },
  },
];

// توحيد الاسم عبر الـ aliases — غير معروف → null (خطأ معطيات)
export function resolveModel(name?: string): ModelDef | null {
  if (!name) return null;
  const norm = name.trim().toLowerCase();
  return (
    MODELS.find((m) => m.canonical.toLowerCase() === norm || m.aliases.map((a) => a.toLowerCase()).includes(norm)) ||
    null
  );
}

export function modelByType(type: MediaType): ModelDef | null {
  return MODELS.find((m) => m.type === type) || null;
}
