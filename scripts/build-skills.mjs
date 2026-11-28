#!/usr/bin/env node
/**
 * build-skills.mjs - Single source of truth pipeline for task knowledge.
 *
 *   src/recipes.json ──┬─► rust/recipes.json          (Rust crate embeds it)
 *                      ├─► skills/<id>/SKILL.md       (Agent Skills format, agentskills.io)
 *                      └─► validation                 (every op name must exist in tools.json)
 *
 * Fails (exit 1) if a recipe references an operation that is not in the
 * catalog, so stale recipes can never ship.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const knowledge = JSON.parse(readFileSync(join(root, "src/recipes.json"), "utf-8"));
const tools = JSON.parse(readFileSync(join(root, "src/tools.json"), "utf-8"));
const names = new Set(tools.tools.map((t) => t.name));

// ── 1. Validate operation names referenced in recipes ──────────────────────
// An operation name looks like `resource_action` in backticks, e.g.
// `apps_getCollection`. Relationship placeholders like {data:...} are skipped.
const OP_RE = /`([a-z][A-Za-z0-9]*_[a-z][A-Za-z0-9]*)`/g;
const bad = [];
for (const r of knowledge.recipes) {
  const text = [...r.steps, ...r.pitfalls].join("\n");
  for (const m of text.matchAll(OP_RE)) {
    if (!names.has(m[1])) bad.push(`${r.id}: ${m[1]}`);
  }
}
for (const [phrase, ops] of Object.entries(knowledge.phrases ?? {})) {
  for (const op of ops) if (!names.has(op)) bad.push(`phrase "${phrase}": ${op}`);
}
if (bad.length) {
  console.error("build-skills: unknown operation names in recipes:\n  " + bad.join("\n  "));
  process.exit(1);
}

// ── 2. Mirror into the Rust crate ──────────────────────────────────────────
writeFileSync(join(root, "rust/recipes.json"), JSON.stringify(knowledge, null, 2) + "\n");

// ── 3. Export Agent Skills (SKILL.md) ──────────────────────────────────────
const skillsDir = join(root, "skills");
rmSync(skillsDir, { recursive: true, force: true });
for (const r of knowledge.recipes) {
  const dir = join(skillsDir, r.id);
  mkdirSync(dir, { recursive: true });
  const fm = [
    "---",
    `name: ${r.id}`,
    `description: ${JSON.stringify(r.description)}`,
    'license: "MIT"',
    'compatibility: "Requires the appstore-connect-mcp MCP server (search_apis, get_tool_details, call_api)."',
    'metadata:',
    '  source: "appstore-connect-mcp"',
    "---",
  ];
  const body = [
    `# ${r.title}`,
    "",
    "Every operation below is called through the MCP tool `call_api` with `name` = the operation name. " +
      "Call `get_tool_details(name)` before the first POST/PATCH of each operation. Responses are JSON:API: ids come from `data.id` / `data[].id`.",
    "",
    ...(r.args.length
      ? ["## Inputs", "", ...r.args.map((a) => `- \`${a.name}\` (${a.required ? "required" : "optional"}): ${a.description}`), ""]
      : []),
    "## Steps",
    "",
    ...r.steps.map((s) => s.replace(/\{\{(\w+)\}\}/g, "<$1>")),
    "",
    ...(r.pitfalls.length ? ["## Pitfalls", "", ...r.pitfalls.map((p) => `- ${p}`), ""] : []),
  ];
  writeFileSync(join(dir, "SKILL.md"), fm.join("\n") + "\n" + body.join("\n"));
}

console.log(
  `build-skills: ${knowledge.recipes.length} recipes validated, mirrored to rust/recipes.json, exported to skills/`
);
