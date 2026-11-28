#!/usr/bin/env node
/**
 * verify-live.mjs - Live-verify the operation catalog and task recipes against
 * a DEDICATED TEST APP in App Store Connect.
 *
 *   node scripts/verify-live.mjs --app <appId> [--tier A|B|AB] [--recipes] [--out reports/live.json]
 *
 * Credentials come from the same env vars as the server:
 *   APP_STORE_CONNECT_ISSUER_ID / APP_STORE_CONNECT_KEY_ID /
 *   APP_STORE_CONNECT_PRIVATE_KEY (PEM) or APP_STORE_CONNECT_P8_FILE (path)
 *
 * Safety model (see classify-ops.cjs for the full breakdown):
 *   Tier A  all GET operations. Discovery builds an id pool from the test app,
 *           then every read is called once (limit=1). Reads on resources the
 *           test app does not have return 404 - still a verified call shape.
 *   Tier B  write steps of the recipes ONLY, scoped to the test app. Never
 *           deletes, submissions, team/signing/webhooks/reviews/offer codes,
 *           tester emails, beta notifications, Xcode Cloud runs.
 *   The run refuses to start unless the app name contains "test" (or --force),
 *           so a production app is never written to by accident.
 *
 * Output: one JSON report with per-call status, latency and the error body, so
 * recipe steps can be diffed against real behaviour.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { callApi } from "../dist/client.js";
import { parsePrivateKey, validateCredentials } from "../dist/auth.js";
import { loadTools } from "../dist/tools.js";
import { loadKnowledge } from "../dist/recipes.js";

const { values: args } = parseArgs({
  options: {
    app: { type: "string" },
    tier: { type: "string", default: "A" },
    recipes: { type: "boolean", default: false },
    out: { type: "string", default: "reports/live-verification.json" },
    force: { type: "boolean", default: false },
    limit: { type: "string", default: "1" },
  },
});
if (!args.app) {
  console.error("usage: verify-live.mjs --app <appId> [--tier A|B|AB] [--recipes] [--out file] [--force]");
  process.exit(2);
}

const data = loadTools();
const knowledge = loadKnowledge();
const byName = new Map(data.tools.map((t) => [t.name, t]));

// ── credentials (mirrors src/index.ts) ──────────────────────────────────────
let privateKey = process.env.APP_STORE_CONNECT_PRIVATE_KEY || "";
const p8 = process.env.APP_STORE_CONNECT_P8_FILE;
if (!privateKey && p8) privateKey = readFileSync(p8, "utf-8");
const creds = {
  issuerId: process.env.APP_STORE_CONNECT_ISSUER_ID || "",
  keyId: process.env.APP_STORE_CONNECT_KEY_ID || "",
  privateKey: privateKey ? parsePrivateKey(privateKey) : "",
};
try {
  validateCredentials(creds);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

// ── report ──────────────────────────────────────────────────────────────────
const report = { startedAt: new Date().toISOString(), appId: args.app, tier: args.tier, calls: [], summary: {} };
let seq = 0;

async function call(name, argOverrides = {}) {
  const tool = byName.get(name);
  if (!tool) return { error: `unknown operation ${name}` };
  const pathParams = {};
  for (const p of tool.pathParams) pathParams[p.name] = argOverrides[p.name] ?? "";
  const queryParams = { ...(argOverrides.query ?? {}) };
  const body = argOverrides.body;
  const t0 = Date.now();
  try {
    const result = await callApi({ method: tool.method, path: tool.path, pathParams, queryParams, body, credentials: creds });
    const entry = { n: ++seq, name, method: tool.method, status: "ok", ms: Date.now() - t0 };
    report.calls.push(entry);
    return { ok: true, result };
  } catch (e) {
    const entry = { n: ++seq, name, method: tool.method, status: "error", http: e.status ?? null, error: String(e.message).slice(0, 300), ms: Date.now() - t0 };
    report.calls.push(entry);
    return { ok: false, status: e.status, error: e.message };
  }
}

const firstId = (result, type) => {
  const d = result?.data;
  const arr = Array.isArray(d) ? d : d ? [d] : [];
  const hit = arr.find((x) => !type || x.type === type);
  return hit?.id;
};

// ── preflight: refuse production apps ───────────────────────────────────────
const app = await call("apps_getInstance", { id: args.app, query: { "fields[apps]": "name,bundleId" } });
if (!app.ok) {
  console.error(`Cannot read app ${args.app}: ${app.error}`);
  process.exit(1);
}
const appName = app.result.data.attributes.name;
report.appName = appName;
if (!/test/i.test(appName) && !args.force) {
  console.error(`Refusing: app "${appName}" does not look like a test app. Re-run with --force if this is intentional.`);
  process.exit(1);
}

// ── discovery: build an id pool from the test app ───────────────────────────
// pool: resourceType -> first id seen. Grown by walking every relationship of
// the test app and every top-level collection (limit 5).
const pool = { apps: args.app };
const learn = (result) => {
  const items = [...(Array.isArray(result?.data) ? result.data : result?.data ? [result.data] : []), ...(result?.included ?? [])];
  for (const it of items) if (it.type && it.id && !pool[it.type]) pool[it.type] = it.id;
};
for (const t of data.tools.filter((t) => t.name.startsWith("apps_") && t.name.endsWith("_getToManyRelated"))) {
  const r = await call(t.name, { id: args.app, query: { limit: 5 } });
  if (r.ok) learn(r.result);
}
for (const t of data.tools.filter((t) => t.name.endsWith("_getCollection"))) {
  const r = await call(t.name, { query: { limit: 5 } });
  if (r.ok) learn(r.result);
}
report.pool = Object.keys(pool).length;

// ── Tier A: every GET once ──────────────────────────────────────────────────
if (args.tier.includes("A")) {
  for (const t of data.tools.filter((t) => t.method === "GET")) {
    const pp = t.pathParams.map((p) => p.name);
    if (pp.length === 0) {
      await call(t.name, { query: { limit: args.limit } });
    } else if (pp.length === 1 && pp[0] === "id") {
      // owner resource = camelCase prefix before the first underscore
      const owner = t.name.split("_")[0];
      const ownerType = Object.keys(pool).find((k) => k.toLowerCase() === owner.toLowerCase());
      if (ownerType) await call(t.name, { id: pool[ownerType], query: { limit: args.limit } });
      else report.calls.push({ n: ++seq, name: t.name, method: t.method, status: "skipped", error: "no fixture id" });
    } else {
      report.calls.push({ n: ++seq, name: t.name, method: t.method, status: "skipped", error: `multi path params ${pp.join(",")}` });
    }
  }
}

// ── Tier B: recipe write steps (opt-in) ─────────────────────────────────────
// Only the recipes' POST/PATCH operations, only against the test app, and only
// those not in the excluded classes. Each recipe is executed with best-effort
// id resolution from the pool; failures are recorded, never retried blindly.
if (args.tier.includes("B") && args.recipes) {
  const EXCLUDE = /deleteInstance|Submissions?_(create|update)|reviewSubmissionItems|BetaNotifications|betaTesters_createInstance|userInvitations|certificates_|profiles_|devices_|bundleIds_|webhook|customerReviewResponse|OfferCodes?_createInstance|OfferCustomCodes?_createInstance|winBackOffers_createInstance|ciBuildRuns_createInstance|sandboxTesters/;
  const ver = pool.appStoreVersions;
  for (const r of knowledge.recipes) {
    const ops = [...r.steps.join("\n").matchAll(/`([a-z][A-Za-z0-9]*_[a-z][A-Za-z0-9]*)`/g)].map((m) => m[1]).filter((n) => byName.get(n) && byName.get(n).method !== "GET" && !EXCLUDE.test(n));
    for (const op of [...new Set(ops)]) {
      const t = byName.get(op);
      const q = {};
      const body = { data: { type: op.split("_")[0], attributes: {} } };
      // minimal fixtures: localizations need a locale + owner; keep bodies empty
      // so Apple validates shape and reports the missing fields - that IS the
      // verification (which fields are required) without inventing data.
      if (op.endsWith("_createInstance")) await call(op, { body, query: q });
      else if (op.endsWith("_updateInstance") && ver && op.startsWith("appStoreVersions_")) await call(op, { id: ver, body: { data: { type: "appStoreVersions", id: ver, attributes: {} } } });
      else report.calls.push({ n: ++seq, name: op, method: t.method, status: "skipped", error: "no fixture for update target" });
    }
  }
}

// ── summary ─────────────────────────────────────────────────────────────────
const s = { ok: 0, error: 0, skipped: 0, byHttp: {} };
for (const c of report.calls) {
  s[c.status] = (s[c.status] ?? 0) + 1;
  if (c.http) s.byHttp[c.http] = (s.byHttp[c.http] ?? 0) + 1;
}
report.summary = s;
report.finishedAt = new Date().toISOString();
mkdirSync(args.out.replace(/\/[^/]+$/, "") || ".", { recursive: true });
writeFileSync(args.out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ app: appName, pool: report.pool, ...s, byHttp: s.byHttp, report: args.out }, null, 2));
