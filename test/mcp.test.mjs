// mcp.test.mjs - Real end-to-end protocol check over stdio.
//
// Spawns the built server exactly the way an MCP client does, performs the
// initialize handshake, and verifies the discovery surface the model relies on:
//   - instructions are delivered at initialize
//   - prompts/list advertises every recipe, prompts/get renders one
//   - search_apis returns ranked, non-empty results for a natural-language query
// An ephemeral P-256 key is generated on the fly so the server's startup JWT
// check passes without any fixture file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      APP_STORE_CONNECT_ISSUER_ID: "test-issuer",
      APP_STORE_CONNECT_KEY_ID: "TESTKEY1",
      APP_STORE_CONNECT_PRIVATE_KEY: pem,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test("initialize delivers instructions that mention prompts and the recipes", async () => {
  const client = await connect();
  try {
    const instructions = client.getInstructions();
    assert.ok(instructions && instructions.length > 200, "instructions must be present");
    assert.match(instructions, /search_apis/);
    assert.match(instructions, /prompts\/get/);
    assert.match(instructions, /submit-for-review/);
    assert.match(instructions, /testflight-distribute/);
  } finally {
    await client.close();
  }
});

test("tools/list still exposes exactly the 4 meta tools", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["call_api", "get_tool_details", "list_categories", "search_apis"]
    );
  } finally {
    await client.close();
  }
});

test("prompts/list advertises every recipe with its arguments", async () => {
  const client = await connect();
  try {
    const { prompts } = await client.listPrompts();
    const ids = prompts.map((p) => p.name);
    assert.ok(ids.length >= 18, `expected >=18 recipes, got ${ids.length}`);
    const submit = prompts.find((p) => p.name === "submit-for-review");
    assert.ok(submit, "submit-for-review prompt missing");
    assert.ok(submit.arguments.some((a) => a.name === "app_id" && a.required));
    assert.match(submit.description, /review/i);
  } finally {
    await client.close();
  }
});

test("prompts/get renders a recipe with argument substitution and verified op names", async () => {
  const client = await connect();
  try {
    const result = await client.getPrompt({
      name: "submit-for-review",
      arguments: { app_id: "123456789" },
    });
    assert.equal(result.messages.length, 1);
    const text = result.messages[0].content.text;
    assert.match(text, /path id=123456789/);
    assert.match(text, /reviewSubmissions_createInstance/);
    assert.match(text, /reviewSubmissionItems_createInstance/);
    assert.match(text, /submitted: true/);
    assert.match(text, /## Pitfalls/);
    assert.ok(!text.includes("{{"), "unsubstituted placeholder left in prompt");

    await assert.rejects(() => client.getPrompt({ name: "does-not-exist" }), /Unknown prompt/);
  } finally {
    await client.close();
  }
});

test("search_apis returns ranked results for a natural-language query", async () => {
  const client = await connect();
  try {
    const res = await client.callTool({
      name: "search_apis",
      arguments: { query: "submit for review" },
    });
    const payload = JSON.parse(res.content[0].text);
    assert.ok(payload.totalMatches > 0, "query must not return 0 matches");
    assert.ok(
      payload.results.slice(0, 10).some((r) => r.name === "reviewSubmissions_createInstance"),
      payload.results.slice(0, 5).map((r) => r.name).join(", ")
    );
    assert.ok(payload.results[0].hasBody !== undefined, "results carry hasBody");
    assert.ok(
      payload.relatedRecipes?.includes("submit-for-review"),
      `search should hint the recipe; got ${JSON.stringify(payload.relatedRecipes)}`
    );

    const miss = await client.callTool({ name: "search_apis", arguments: { query: "zzzqqqxyz" } });
    const missPayload = JSON.parse(miss.content[0].text);
    assert.equal(missPayload.totalMatches, 0);
    assert.match(missPayload.hint, /prompts\/get/);
  } finally {
    await client.close();
  }
});
