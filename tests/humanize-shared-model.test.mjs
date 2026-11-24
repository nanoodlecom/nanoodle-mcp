// Two writers on one model (D and E both run tencent/hy4-flash since
// 2026-11-23) must each get the full guard treatment: humanizeFetch tells
// them apart by model + system prompt (their voice prompts differ), where
// it used to key on the model alone and leave both writers unidentified —
// and therefore unguarded — whenever a model was shared.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { humanizeFetch, humanizeWriterRecord, collectSpans } from "../src/humanize.mjs";
import { HUMANIZE_MODEL_PRICES } from "../src/humanize-deposit.mjs";

const graph = JSON.parse(await readFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), "utf8"));
const record = humanizeWriterRecord(graph);
const CHAT_URL = "http://x/api/v1/chat/completions";
const DRAFT = "Thanks for sharing this, the drop from 14 to 6 minutes on CI is really great work.";

const letterOf = (body) => {
  const sys = (body.messages || []).filter((m) => m.role === "system").map((m) => m.content).join("\n");
  if (body.model === "tencent/hy4-flash") return sys.includes("Voice for this rewrite: plain") ? "D" : "E";
  return Object.keys(record).find((l) => record[l].model === body.model);
};
const bodyFor = (letter, user) => JSON.stringify({
  model: record[letter].model, max_tokens: 600,
  messages: [{ role: "system", content: record[letter].system }, { role: "user", content: user }],
});
const reply = (content) => Promise.resolve(new Response(JSON.stringify({
  choices: [{ message: { content } }], x_nanogpt_pricing: { costUsd: 0.0001 },
}), { status: 200, headers: { "content-type": "application/json" } }));

test("the fixture record itself shares one model across D and E, told apart by voice prompt", () => {
  assert.equal(record.D.model, "tencent/hy4-flash");
  assert.equal(record.E.model, "tencent/hy4-flash");
  assert.notEqual(record.D.system, record.E.system);
});

test("shared model: the near-copy re-ask fires for D and both writers are metered", async () => {
  const hf = humanizeFetch({
    record, draft: DRAFT, budgetUsd: 1, prices: HUMANIZE_MODEL_PRICES,
    fetch: (_url, init) => {
      const body = JSON.parse(init.body);
      const letter = letterOf(body);
      if (letter === "D") return reply(body.messages.length > 2 ? "You took CI from 14 to 6 minutes. Thanks for writing it up." : DRAFT);
      if (letter === "E") return reply("14 to 6, love it.");
      return reply("A rewrite of the draft in another voice.");
    },
  });
  for (const l of ["A", "B", "C", "D", "E"]) await hf.fetch(CHAT_URL, { method: "POST", body: bodyFor(l, DRAFT) });
  assert.equal(hf.state.answered.D, "tencent/hy4-flash", "D answered under the shared model");
  assert.equal(hf.state.answered.E, "tencent/hy4-flash", "E answered under the shared model");
  assert.ok(hf.state.reasked.D, "D's near-copy was re-asked: the guard saw D despite the shared model");
  assert.equal(hf.state.reasked.E, undefined, "E's clean rewrite was not re-asked");
  // 5 writers + D's re-ask, every call metered against the budget.
  assert.ok(Math.abs(hf.state.meteredUsd - 0.0006) < 1e-9, `metered ${hf.state.meteredUsd}, expected 0.0006`);
});

test("shared model: a keep-span violation drops D while E, on the same model, answers", async () => {
  const draft = "Please keep the name Ada Lovelace in the reply.";
  const { writerDraft, spans } = collectSpans(draft, ["Ada Lovelace"]);
  assert.ok(writerDraft.includes("[[k1]]"));
  const hf = humanizeFetch({
    record, draft, writerDraft, spans, budgetUsd: 1, prices: HUMANIZE_MODEL_PRICES,
    fetch: (_url, init) => {
      const body = JSON.parse(init.body);
      const letter = letterOf(body);
      if (letter === "D") return reply("The reply is ready and the name is in it."); // [[k1]] dropped
      if (letter === "E") return reply("[[k1]] is in the reply, as asked.");
      return reply("A rewrite of the draft in another voice.");
    },
  });
  for (const l of ["A", "B", "C", "D", "E"]) await hf.fetch(CHAT_URL, { method: "POST", body: bodyFor(l, writerDraft) });
  assert.ok(hf.state.dropped.D, "D's span violation was caught and dropped before the decider");
  assert.equal(hf.state.answered.D, undefined, "D has no surviving rewrite");
  assert.equal(hf.state.answered.E, "tencent/hy4-flash", "E kept the span and answered on the same model");
  assert.equal(hf.state.dropped.E, undefined);
});
