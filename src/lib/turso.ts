/* طبقة Turso: عميل واحد عبر HTTP (متوافق مع Vercel) + إنشاء المخطط عند أول وصول */
import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;
let schemaPromise: Promise<void> | null = null;

export function getDb(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرا البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزاميان");
    }
    // اتصال عبر HTTP فقط — لا ملفات SQLite محلية في الإنتاج
    client = createClient({ url, authToken: token });
  }
  return client;
}

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    provider TEXT,
    provider_task_id TEXT,
    key_id TEXT,
    model TEXT NOT NULL,
    type TEXT NOT NULL,
    prompt TEXT DEFAULT '',
    params_json TEXT DEFAULT '{}',
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    result_urls_json TEXT,
    error_message TEXT,
    attempts_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT DEFAULT '',
    api_key TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    usage_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    last_used_at TEXT,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
];

export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getDb();
      for (const sql of SCHEMA_SQL) await db.execute(sql);
    })();
  }
  return schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    const r = await getDb().execute("SELECT 1");
    return r.rows.length === 1;
  } catch {
    return false;
  }
}

// ---- أنواع صفوف قاعدة البيانات ----
export interface Attempt {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string;
  prompt: string;
  params_json: string;
  status: string;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface KeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

function rowToTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    provider: (r.provider as string) ?? null,
    provider_task_id: (r.provider_task_id as string) ?? null,
    key_id: (r.key_id as string) ?? null,
    model: String(r.model),
    type: String(r.type),
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: String(r.status),
    progress: Number(r.progress ?? 0),
    result_urls_json: (r.result_urls_json as string) ?? null,
    error_message: (r.error_message as string) ?? null,
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    completed_at: (r.completed_at as string) ?? null,
  };
}

function rowToKey(r: Record<string, unknown>): KeyRow {
  return {
    id: String(r.id),
    provider: String(r.provider),
    label: String(r.label ?? ""),
    api_key: String(r.api_key),
    status: String(r.status ?? "active"),
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: String(r.created_at),
  };
}

// ---- عمليات المهام ----
export interface TaskPatch {
  provider?: string;
  provider_task_id?: string | null;
  key_id?: string | null;
  model?: string;
  status?: string;
  progress?: number;
  result_urls_json?: string | null;
  error_message?: string | null;
  appendAttempt?: Attempt;
}

export async function insertTask(t: {
  id: string;
  provider?: string;
  provider_task_id?: string;
  key_id?: string;
  model: string;
  type: string;
  prompt?: string;
  params_json?: string;
  status: string;
}): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.params_json ?? "{}",
      t.status,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getDb().execute({ sql: `SELECT * FROM tasks WHERE id = ?`, args: [id] });
  if (!r.rows.length) return null;
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>);
}

// patch جزئي + إلحاق محاولة إلى attempts_json + ضبط completed_at تلقائيًا عند الاكتمال
export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
  await ensureSchema();
  const current = await getTask(id);
  if (!current) return null;

  if (patch.appendAttempt) {
    const attempts: Attempt[] = JSON.parse(current.attempts_json || "[]");
    attempts.push({ ...patch.appendAttempt, at: patch.appendAttempt.at || new Date().toISOString() });
    await getDb().execute({
      sql: `UPDATE tasks SET attempts_json = ? WHERE id = ?`,
      args: [JSON.stringify(attempts.slice(-50)), id], // نحتفظ بآخر 50 محاولة
    });
  }

  const sets: string[] = [`updated_at = datetime('now')`];
  const args: (string | number | null)[] = [];
  const cols: Record<string, string | number | null | undefined> = {
    provider: patch.provider,
    provider_task_id: patch.provider_task_id,
    key_id: patch.key_id,
    model: patch.model,
    status: patch.status,
    progress: patch.progress,
    result_urls_json: patch.result_urls_json,
    error_message: patch.error_message,
  };
  for (const [k, v] of Object.entries(cols)) {
    if (v !== undefined) {
      sets.push(`${k} = ?`);
      args.push(v as string | number | null);
    }
  }
  if (patch.status === "completed") sets.push(`completed_at = COALESCE(completed_at, datetime('now'))`);
  if (sets.length > 1) {
    args.push(id);
    await getDb().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
  }
  return getTask(id);
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: string; status?: string }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filters?.type) { where.push("type = ?"); args.push(filters.type); }
  if (filters?.status) { where.push("status = ?"); args.push(filters.status); }
  args.push(Math.min(50, Math.max(1, limit)));
  const r = await getDb().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args,
  });
  return r.rows.map((x) => rowToTask(x as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const r = await getDb().execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('processing', 'pending') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const row = r.rows[0] as unknown as Record<string, unknown>;
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}

// ---- عمليات المفاتيح ----
export async function insertKey(k: { id: string; provider: string; label?: string; api_key: string }): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [k.id, k.provider, k.label ?? "", k.api_key],
  });
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const r = await getDb().execute({ sql: `SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`, args: [] });
  return r.rows.map((x) => x as unknown as KeyRow);
}

export async function getKey(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const r = await getDb().execute({ sql: `SELECT * FROM api_keys WHERE id = ?`, args: [id] });
  if (!r.rows.length) return null;
  return r.rows[0] as unknown as KeyRow;
}

export async function setKeyStatus(id: string, status: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: `UPDATE api_keys SET status = ? WHERE id = ?`, args: [status, id] });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
}
