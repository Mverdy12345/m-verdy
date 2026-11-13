/* GET /api/cron — حذف المهام المنتهية صلاحيتها (مجدولة يوميًا في vercel.json) */
"use strict";
const { guard, sendJson } = require("../lib/util");
const db = require("../lib/db");

module.exports = guard(async (req, res) => {
  await db.ensureSchema();
  const deleted = await db.cleanupExpired();
  return sendJson(res, 200, { ok: true, deleted, at: new Date().toISOString() });
});
