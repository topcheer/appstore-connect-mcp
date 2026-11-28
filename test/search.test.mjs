// search.test.mjs - Regression tests for ranked search (dist/search.ts).
//
// Every query here returned 0 results with the old literal-substring search.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OpSearch } from "../dist/search.js";

const data = JSON.parse(readFileSync(new URL("../src/tools.json", import.meta.url), "utf-8"));
const knowledge = JSON.parse(readFileSync(new URL("../src/recipes.json", import.meta.url), "utf-8"));
const search = new OpSearch(data, knowledge);

const top = (q, n = 10) => search.search(q).slice(0, n).map((t) => t.name);

test("natural-language queries that used to return 0 now find the operation", () => {
  const cases = [
    ["submit for review", "reviewSubmissions_createInstance"],
    ["submit app for review", "reviewSubmissions_createInstance"],
    ["testflight", "betaGroups_createInstance"],
    ["add tester", "betaTesters_createInstance"],
    ["upload build", "buildUploads_createInstance"],
    ["pricing", "apps_appPricePoints_getToManyRelated"],
    ["replace build", "appStoreVersions_updateInstance"],
    ["promo code", "subscriptionOfferCodes_createInstance"],
    ["sales report", "salesReports_getCollection"],
    ["phased release", "appStoreVersionPhasedReleases_createInstance"],
    ["crash logs", "betaFeedbackCrashSubmissions_getInstance"],
    ["reply to review", "customerReviewResponses_createInstance"],
    ["export compliance", "appEncryptionDeclarations_createInstance"],
    ["invite user", "userInvitations_createInstance"],
  ];
  for (const [query, expected] of cases) {
    const hits = top(query, 15);
    assert.ok(hits.includes(expected), `'${query}' should surface ${expected}; got ${hits.slice(0, 5).join(", ")}`);
  }
});

test("ranking puts the direct resource action before relationship helpers", () => {
  const hits = top("beta tester", 5);
  assert.equal(hits[0], "betaTesters_createInstance");
  assert.ok(!hits.some((h) => /Relationship$/.test(h)), hits.join(", "));
  const r = top("review submission create", 5);
  assert.equal(r[0], "reviewSubmissions_createInstance");
});

test("intent phrases pin the semantically right operation", () => {
  assert.equal(top("replace build", 5)[0], "appStoreVersions_updateInstance");
  assert.equal(top("submit app for review", 5)[0], "reviewSubmissions_createInstance");
  assert.equal(top("release now")[0], "appStoreVersionReleaseRequests_createInstance");
});

test("relatedRecipes points at the task recipe for a query", () => {
  assert.ok(search.relatedRecipes("replace build").includes("replace-build-on-version"));
  assert.ok(search.relatedRecipes("submit for review").includes("submit-for-review"));
  assert.ok(search.relatedRecipes("testflight external testers").includes("testflight-distribute"));
});

test("single overloaded word no longer floods: 'app' ranks canonical ops first", () => {
  const hits = top("app", 8);
  assert.ok(hits[0].startsWith("apps_"), hits.join(", "));
  assert.ok(hits.length <= 8);
});

test("category and method filters combine with ranking", () => {
  const hits = search.search("tester", "BetaTesters", "POST").map((t) => t.name);
  assert.equal(hits[0], "betaTesters_createInstance");
  assert.ok(hits.every((h) => /betaTester/.test(h)));
});

test("no-match returns empty instead of throwing", () => {
  assert.deepEqual(search.search("zzzqqqxyz"), []);
});

test("tokenize splits camelCase and snake_case", async () => {
  const { tokenize } = await import("../dist/search.js");
  assert.deepEqual(tokenize("appStoreVersions_getToManyRelated"), ["app", "store", "versions", "get", "to", "many", "related"]);
});
