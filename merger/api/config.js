/* GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية) */
"use strict";
const { guard, sendJson, LIMITS } = require("../lib/util");

module.exports = guard(async (req, res) => {
  return sendJson(res, 200, {
    version: "2.0.0",
    service: "m-verdy-merger",
    limits: {
      maxSources: LIMITS.maxSources,
      sourceMaxMB: Math.floor(LIMITS.sourceMaxBytes / 1024 / 1024),
      outputMaxMB: Math.floor(LIMITS.outputMaxBytes / 1024 / 1024),
      maxTotalDurationSec: LIMITS.maxTotalDurationSec,
      uploadChunkBytes: LIMITS.uploadChunkBytes,
      retentionHours: LIMITS.ttlHours,
      resolutionCap: "1920x1080",
      codec: "H.264 (CRF 18) + AAC 192k",
    },
  });
});
