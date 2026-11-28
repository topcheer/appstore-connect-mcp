/**
 * recipes.ts - Task knowledge: curated multi-step workflows over the API.
 *
 * The App Store Connect OpenAPI spec ships with zero descriptions, so the
 * operation catalog alone cannot tell a model WHICH calls make up a task
 * like "submit for review" (4 calls, in a fixed order). Recipes fill that
 * gap. They are exposed to clients as MCP prompts (prompts/list,
 * prompts/get) and summarized in the server instructions.
 *
 * Single source of truth: src/recipes.json (mirrored to rust/recipes.json
 * and exported to skills/<id>/SKILL.md by scripts/build-skills.mjs).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface RecipeArg {
  name: string;
  description: string;
  required: boolean;
}

export interface Recipe {
  id: string;
  title: string;
  /** When to use - shown in prompts/list so the client can pick the right one. */
  description: string;
  args: RecipeArg[];
  steps: string[];
  pitfalls: string[];
}

export interface Knowledge {
  "$comment"?: string;
  synonyms: Record<string, string[]>;
  /** Intent phrases -> operations pinned to the top of search results. */
  phrases?: Record<string, string[]>;
  recipes: Recipe[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadKnowledge(): Knowledge {
  const raw = readFileSync(join(__dirname, "recipes.json"), "utf-8");
  return JSON.parse(raw) as Knowledge;
}

/** Substitute {{arg}} placeholders with caller-supplied values. */
export function renderRecipe(recipe: Recipe, args: Record<string, string>): string {
  const values: Record<string, string> = {};
  for (const a of recipe.args) {
    values[a.name] = (args[a.name] ?? `<${a.name}>`).toString();
  }
  const sub = (text: string) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? `<${k}>`);

  const lines: string[] = [];
  lines.push(`# ${recipe.title}`);
  lines.push("");
  lines.push(
    "Every operation below is called through `call_api` with `name` = the operation name. " +
      "Call `get_tool_details(name)` before the first POST/PATCH of each operation to get the exact " +
      "body schema and attribute enums. Responses are JSON:API: ids come from `data.id` / `data[].id`. " +
      "Operation names and body fields are verified against the API catalog; the step order follows Apple's " +
      "documented workflows - if a step fails with 403/409, re-read the error and adjust rather than retrying blindly."
  );
  lines.push("");
  for (const step of recipe.steps) lines.push(sub(step));
  if (recipe.pitfalls.length) {
    lines.push("");
    lines.push("## Pitfalls");
    for (const p of recipe.pitfalls) lines.push(`- ${sub(p)}`);
  }
  return lines.join("\n");
}

/**
 * Server instructions: injected into the model's context at initialize.
 * Keep it short - it is paid on every conversation - and point at the
 * recipes so the model reaches for the right operation chain.
 */
export function buildInstructions(knowledge: Knowledge, totalOps: number): string {
  const index = knowledge.recipes.map((r) => `- ${r.id}: ${r.description.replace(/^Use when the user wants to /, "")}`).join("\n");
  return [
    "App Store Connect API with " + totalOps + " operations exposed through 4 tools (search_apis, get_tool_details, call_api, list_categories).",
    "",
    "## How to find the right operation",
    "- search_apis is tokenized and ranked; use 1-4 keywords (e.g. 'review submit', 'beta tester', 'price'). Common terms are mapped to API vocabulary (testflight->beta, pricing->pricePoint, promo->offerCode, listing->appStoreVersionLocalization).",
    "- Names follow <resource>_<action>: getCollection / getInstance / createInstance / updateInstance / deleteInstance / <related>_getToManyRelated / <related>_createToManyRelationship. Filtering is done with query params like filter[app], filter[platform], sort=-createdDate, limit, fields[<type>].",
    "- Always call get_tool_details(name) before call_api for POST/PATCH: it returns the exact JSON:API body (data.type, attributes, relationships) and an example body. GETs only need the path params shown in the path.",
    "- Live-verified quirks: getInstance / getToOneRelated / getToOneRelationship reject `limit` (PARAMETER_ERROR.ILLEGAL); metrics endpoints (*_getMetrics) only accept `limit` together with `groupBy` or `filter`; several collections require a filter the spec marks optional - reviewSubmissions_getCollection needs filter[app], actors/nominations/betaAppReviewDetails/betaAppReviewSubmissions/buildBetaDetails need filter[app] or filter[build]; `GET /v1/apps/{id}/appEncryptionDeclarations` does not exist on the live API (use appEncryptionDeclarations_getCollection with filter[app]). Report endpoints (salesReports, financeReports) return gzip files: pass `_accept` in call_api arguments ('application/a-gzip'; the result is {_binary:{base64}} or a file path); perfPowerMetrics needs `_accept`='*/*'.",
    "- Results are JSON:API. Chain ids: data[0].id, data.id, included[]. For collections follow links.next - it carries a `cursor` query param - and read meta.paging.total for the count.",
    "- Apps cannot be created through this API (create the app in App Store Connect first); everything else - IAPs, subscriptions, versions, testers, prices, screenshots - is supported.",
    "",
    "## Task recipes (multi-call workflows)",
    "For these tasks, fetch the recipe first with prompts/get (name = recipe id, pass its arguments) instead of discovering the chain by searching:",
    index,
    "",
    "Destructive calls (deleteInstance, replace/delete relationships, submitted=true) require explicit user confirmation of the target id.",
  ].join("\n");
}
