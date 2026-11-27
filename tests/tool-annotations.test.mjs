/**
 * Every tool the server lists carries a human title and MCP annotations
 * (title + readOnlyHint/destructiveHint at minimum). Directory reviewers —
 * the Claude Connectors Directory portal, OpenAI's plugin directory — flag
 * tools missing them, so listTools() output is pinned here: free design
 * helpers are read-only, everything that runs a workflow is not, and nothing
 * claims to be destructive (no tool deletes or overwrites caller data).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTools } from "../src/tools.mjs";
import { createHostedWorkflows } from "../src/hosted-workflows.mjs";
import { nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { deriveAddress, derivePublicKey, deriveSecretKey } from "nanocurrency";

const here = dirname(fileURLToPath(import.meta.url));

const assertAnnotated = (tool, { readOnly }) => {
  assert.equal(typeof tool.title, "string", `${tool.name} has a title`);
  assert.ok(tool.title.length > 0, `${tool.name} title is non-empty`);
  const a = tool.annotations;
  assert.ok(a && typeof a === "object", `${tool.name} has annotations`);
  assert.equal(a.readOnlyHint, readOnly, `${tool.name} readOnlyHint`);
  assert.equal(a.destructiveHint, false, `${tool.name} destructiveHint`);
  assert.equal(typeof a.idempotentHint, "boolean", `${tool.name} idempotentHint present`);
  assert.equal(a.idempotentHint, readOnly, `${tool.name} idempotentHint matches its class`);
};

test("registry tools/list: every tool carries a title and honest annotations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nd-annotations-"));
  const graph = await readFile(join(here, "fixtures", "hello-noodle.json"), "utf8");
  await writeFile(join(dir, "hello-noodle.json"), graph);
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", outDir: dir, log: () => {} });
  const tools = registry.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  // The free design helpers never run anything.
  assertAnnotated(byName.get("price_noodle"), { readOnly: true });
  assertAnnotated(byName.get("noodle_guide"), { readOnly: true });
  // run_noodle and every saved-workflow tool execute and spend per call.
  assertAnnotated(byName.get("run_noodle"), { readOnly: false });
  assertAnnotated(byName.get("hello-noodle"), { readOnly: false });
  assert.equal(byName.get("hello-noodle").title, "Hello noodle");
  // The built-in sfw_check ships whenever a graph loads; it runs a model.
  assertAnnotated(byName.get("sfw_check"), { readOnly: false });
  assert.equal(byName.get("sfw_check").title, "Check if media is safe for work");
  // No tool in the list is unannotated.
  for (const tool of tools) assertAnnotated(tool, { readOnly: tool.annotations.readOnlyHint });
});

let nano;
before(async () => { nano = nanoGptMock(); await nano.listen(); });
after(async () => { await nano.close(); });

test("hosted workflow tools: price_workflow reads, run_workflow executes", async () => {
  const author = deriveAddress(derivePublicKey(deriveSecretKey("0".repeat(64), 2)), { useNanoPrefix: true });
  const creators = createHostedWorkflows({
    dir: mkdtempSync(join(tmpdir(), "hosted-annotations-")), publicBase: "https://near.example", merchant: "merchant.near",
    network: "mainnet", usdc: { enabled: true }, baseUrl: nano.url,
  });
  const { id } = await creators.submit({ name: "Idea into a poster", description: "Supply an idea; receive a finished poster.", graph: { ...WORKED_GRAPH, x402: { author } } });
  const [run, price] = creators.listTools(id);
  assertAnnotated(run, { readOnly: false });
  assert.equal(run.title, "Idea into a poster");
  assertAnnotated(price, { readOnly: true });
  assert.match(price.title, /\(free\)$/);
});
