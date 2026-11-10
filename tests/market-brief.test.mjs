// The job-brief format the Agent Market worker accepts (src/market/brief.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrief, BriefError, BRIEF_TEMPLATE, fencedBlocks } from "../src/market/brief.mjs";

const REQ = { graph: { v: 1, nodes: [], links: [] }, inputs: { Idea: "x" } };
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof BriefError, String(e)); return e.code; } return null; };

test("a block tagged nanoodle is the request; prose around it is ignored", () => {
  const brief = `Hi! Please run this.\n\n\`\`\`nanoodle\n${JSON.stringify(REQ, null, 2)}\n\`\`\`\n\nThanks`;
  assert.deepEqual(parseBrief(brief), REQ);
});

test("json nanoodle, ~~~ fences and longer fences are read", () => {
  assert.deepEqual(parseBrief(`\`\`\`json nanoodle\n${JSON.stringify(REQ)}\n\`\`\``), REQ);
  assert.deepEqual(parseBrief(`~~~nanoodle\n${JSON.stringify(REQ)}\n~~~`), REQ);
  assert.deepEqual(parseBrief(`\`\`\`\`nanoodle\n${JSON.stringify({ ...REQ, inputs: { Idea: "```" } })}\n\`\`\`\``).inputs.Idea, "```");
});

test("one json block is used when none is tagged nanoodle; a nanoodle tag wins over other json blocks", () => {
  assert.deepEqual(parseBrief(`\`\`\`json\n${JSON.stringify(REQ)}\n\`\`\``), REQ);
  const two = `\`\`\`json\n{"note": 1}\n\`\`\`\n\`\`\`nanoodle\n${JSON.stringify(REQ)}\n\`\`\``;
  assert.deepEqual(parseBrief(two), REQ);
});

test("a brief that is only the JSON object is accepted", () => {
  assert.deepEqual(parseBrief(`  ${JSON.stringify({ url: "https://nanoodle.com/#g=abc" })}\n`), { url: "https://nanoodle.com/#g=abc" });
});

test("refusals: none, ambiguous, bad JSON, not an object, unknown keys", () => {
  assert.equal(code(() => parseBrief("Make me a picture of a cat")), "NO_REQUEST");
  assert.equal(code(() => parseBrief("")), "NO_REQUEST");
  assert.equal(code(() => parseBrief("```json\n{}\n```\n```json\n{}\n```")), "AMBIGUOUS");
  assert.equal(code(() => parseBrief("```nanoodle\n{}\n```\n```nanoodle\n{}\n```")), "AMBIGUOUS");
  assert.equal(code(() => parseBrief("```nanoodle\n{ graph: 1 }\n```")), "BAD_JSON");
  assert.equal(code(() => parseBrief("```nanoodle\n[1,2]\n```")), "BAD_REQUEST");
  const e = (() => { try { parseBrief('```nanoodle\n{"graph":{},"input":{}}\n```'); } catch (x) { return x; } })();
  assert.equal(e.code, "BAD_REQUEST");
  assert.match(e.message, /"input"/);
});

test("graph/url/inputs shape problems are left to the shared readGraphArgs (not re-implemented here)", () => {
  assert.deepEqual(parseBrief('```nanoodle\n{"graph":{},"url":"x"}\n```'), { graph: {}, url: "x" });
});

test("the published template parses", () => {
  const args = parseBrief(BRIEF_TEMPLATE);
  assert.equal(args.inputs.Idea, "a lighthouse at dawn");
  assert.equal(args.graph.nodes.length, 2);
});

test("an unclosed fence runs to the end of the brief", () => {
  assert.deepEqual(fencedBlocks("```nanoodle\n{}\n"), [{ info: "nanoodle", body: "{}\n" }]);
});
