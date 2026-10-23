// humanize-comment v2.8: keep spans, ending, guidance cap, maxChars, writer-echo.
// Offline — every model call is a local stub. No network, no charge gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/tools.mjs";
import { ONE_THREAD_PREFIX, guidanceUnits, HUMANIZE_INPUT_CAPS, humanizeExtraProperties } from "../src/humanize.mjs";

const JOKE = "Guilty, I paid for ears I don't have.";
const MODELS = ["qwen/qwen3.8-27b-novelist", "deepseek/deepseek-v4.1-flash-1017", "TheDrummer/Cydonia-24B-v4.3", "qwen/qwen3.8-27b-antislop", "inception/mercury-3"];

function judge(winner, order, why = "ok") {
  return JSON.stringify({
    winner, text: "decider copy", why,
    ranked: order.map((w) => ({ writer: w, faithful: true, disqualified: false, reason: "ok" })),
  });
}

async function runHumanize(t, reply, args) {
  const { createServer } = await import("node:http");
  const seen = [];
  let judgePrompt = "";
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const user = (body.messages || []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
      const reask = (body.messages || []).length > 2;
      seen.push({ model: body.model, user, reask, messages: body.messages || [] });
      let content;
      if (body.model === "z-ai/glm-5.3") {
        judgePrompt = user;
        content = reply(body, { user, reask, judge: true });
      } else content = reply(body, { user, reask, judge: false });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: content == null ? "" : content } }], x_nanogpt_pricing: { costUsd: 0.0001 } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-v28-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", baseUrl: "http://127.0.0.1:" + srv.address().port, outDir: join(dir, "out"), log: () => {} });
  const result = await registry.callTool({ name: "humanize-comment", arguments: args });
  const texts = result.content.map((c) => c.text || "");
  const block = texts.find((x) => /^\{"winner"/.test(x));
  return { result, texts, json: block ? JSON.parse(block) : null, seen, judgePrompt, registry };
}

test("v2.8 schema: keep, ending, maxChars, and a 600-character guidance cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-v28-schema-"));
  try {
    await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
    const registry = await loadTools({ dirs: [dir], outDir: join(dir, "out"), log: () => {} });
    const tool = registry.listTools().find((t) => t.name === "humanize-comment");
    assert.deepEqual(tool.inputSchema.properties.keep, humanizeExtraProperties().keep);
    assert.deepEqual(tool.inputSchema.properties.ending, humanizeExtraProperties().ending);
    assert.deepEqual(tool.inputSchema.properties.maxChars, humanizeExtraProperties().maxChars);
    assert.equal(tool.inputSchema.properties.ending.default, "any");
    assert.deepEqual(tool.inputSchema.properties.ending.enum, ["question", "keep_last", "any"]);
    assert.equal(HUMANIZE_INPUT_CAPS.Guidance, 600);
    assert.equal(guidanceUnits("g".repeat(600)), 600);
    assert.equal(guidanceUnits("g".repeat(601)), 601);
    assert.equal(guidanceUnits(ONE_THREAD_PREFIX + "g".repeat(600)), 600);
    assert.equal(guidanceUnits(ONE_THREAD_PREFIX + "g".repeat(601)), 601);
    assert.match(tool.inputSchema.properties.Guidance.description, /at most 600 characters/);
    assert.match(tool.inputSchema.properties.Guidance.description, /not counted/);
    assert.equal([...ONE_THREAD_PREFIX].length, 145);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a keep span survives every writer, and an altered one is dropped before the decider", async (t) => {
  const draft = `You cut the suite from 14 minutes to 6. ${JOKE}`;
  let calls = { A: 0 };
  const { json, texts, seen, judgePrompt } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
    const letter = { [MODELS[0]]: "A", [MODELS[1]]: "B", [MODELS[2]]: "C", [MODELS[3]]: "D", [MODELS[4]]: "E" }[body.model];
    if (letter === "A") {
      calls.A++;
      return ctx.reask || calls.A > 1 ? "Changed the line: guilty, ears I do not have." : "Changed the line: guilty, ears I do not have.";
    }
    return `You got it down to 6 minutes. [[k1]]`;
  }, { Draft: draft, Context: "CI went from 14 to 6.", keep: [JOKE] });
  assert.equal(json.winner !== "A", true);
  assert.equal(json.text.includes(JOKE), true);
  assert.equal(json.text.split(JOKE).length - 1, 1);
  for (const row of json.ranked) {
    if (row.text) {
      assert.equal(row.text.includes(JOKE), true, row.writer);
      assert.equal(row.text.includes("[[k"), false, row.writer);
    }
  }
  assert.equal(json.ranked.find((r) => r.writer === "A").text, "");
  assert.match(json.ranked.find((r) => r.writer === "A").reason, /protected span/);
  // writers were shown a placeholder, not the joke
  const writerUsers = seen.filter((s) => s.model !== "z-ai/glm-5.3" && !s.reask);
  assert.ok(writerUsers.length >= 5);
  for (const s of writerUsers) {
    assert.match(s.user, /\[\[k1\]\]/);
    assert.equal(s.user.includes(JOKE), false);
  }
  // the decider sees the joke restored, and never the altered line or the placeholder
  assert.equal(judgePrompt.includes("[[k1]]"), false);
  assert.equal(judgePrompt.includes(JOKE), true);
  assert.equal(judgePrompt.includes("ears I do not have"), false);
  assert.equal(texts.join("\n").includes("ears I do not have"), false);
});

test("keep_last ends on the last keep span, or on the draft's final sentence", async (t) => {
  const joke = "That is the whole bit.";
  const { json } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("B", ["B", "A", "C", "D", "E"]);
    return "[[k1]] You shipped the fix.";
  }, { Draft: `You shipped the fix. ${joke}`, Context: "a fix", keep: [joke], ending: "keep_last" });
  assert.ok(json.text.endsWith(joke), json.text);
  assert.equal(json.text.split(joke).length - 1, 1);

  const { json: plain } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
    return "Rewritten point only.";
  }, { Draft: "First point here. Last sentence stays.", Context: "a note", ending: "keep_last" });
  assert.ok(plain.text.endsWith("Last sentence stays."), plain.text);
});

test("ending question makes the rewrite end with a question", async (t) => {
  const { json } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("C", ["C", "A", "B", "D", "E"]);
    return "Nice work on the cut.";
  }, { Draft: "The cut landed. How did you do it?", Context: "a cut", ending: "question" });
  assert.ok(/\?\s*$/.test(json.text), json.text);
  assert.ok(json.text.endsWith("How did you do it?"), json.text);
});

test("maxChars rejects an over-length rewrite even when the decider picks it", async (t) => {
  const long = "word ".repeat(30).trim();
  assert.ok([...long].length > 40);
  const { json, seen } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
    if (body.model === MODELS[0]) return long;
    return "Short and fine.";
  }, { Draft: "Please keep this short.", Context: "a note", maxChars: 40 });
  assert.equal(json.winner !== "A", true);
  assert.ok([...json.text].length <= 40, json.text);
  assert.equal(json.text, "Short and fine.");
  const aCalls = seen.filter((s) => s.model === MODELS[0]);
  assert.equal(aCalls.length, 2, "the over-length writer is asked once more");
  assert.equal(json.text.includes(long), false);
});

test("the guidance-wrapper echo is never picked, and a title paragraph is dropped", async (t) => {
  const echo = `<comment>${ONE_THREAD_PREFIX}Keep the title.</comment>`;
  const paragraph = "This is a whole paragraph about the change and it keeps going well past a title. ".repeat(4).trim();
  assert.ok([...paragraph].length > 220);
  const { json, texts, judgePrompt } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("A", ["A", "C", "B", "D", "E"], "the wrapper looked confident");
    if (body.model === MODELS[0]) return echo;
    if (body.model === MODELS[2]) return paragraph;
    return "CI cut, nice.";
  }, { Draft: "CI cut", Context: "a title", Guidance: "Rewrite the title." });
  assert.equal(json.text, "CI cut, nice.");
  assert.equal(json.winner !== "A" && json.winner !== "C", true);
  const blob = texts.join("\n") + "\n" + judgePrompt;
  assert.equal(blob.includes("<comment"), false);
  assert.equal(blob.includes("</comment>"), false);
  assert.equal(blob.includes("One thread: ONE main point"), false);
  assert.equal(blob.includes(paragraph.slice(0, 80)), false);
});

test("an old-style call is unchanged: same shape, same text, no new prompt, same price", async (t) => {
  const draft = "Thanks for sharing this.";
  const { json, texts, seen, judgePrompt, result } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"], "most human");
    return "rewrite by " + body.model;
  }, { Draft: draft, Context: "We cut CI from 14 to 6 minutes." });
  assert.notEqual(result.isError, true);
  assert.deepEqual(Object.keys(json).sort(), ["ranked", "text", "why", "winner"]);
  assert.equal(json.winner, "A");
  assert.equal(json.text, "rewrite by " + MODELS[0]);
  assert.equal(json.ranked.length, 5);
  for (const row of json.ranked) assert.equal(row.text, "rewrite by " + row.model);
  assert.ok(texts.includes("cost: $0.0006"), texts.find((x) => /^cost/.test(x)));
  const writers = seen.filter((s) => s.model !== "z-ai/glm-5.3");
  assert.equal(writers.length, 5, "no guard retry and no re-ask on an old-style call");
  for (const s of writers) {
    assert.equal(s.user.includes("[[k"), false);
    assert.equal(s.user.includes("Protected placeholders"), false);
    assert.equal(s.user.includes("One thread: ONE main point"), false);
    assert.equal(s.user.includes("Stay under"), false);
    assert.match(s.user, /Thanks for sharing this\./);
  }
  assert.equal(judgePrompt.includes("One thread: ONE main point"), false);
  assert.match(judgePrompt, /a friendly, specific reply/);
  assert.match(judgePrompt, /\[ORIGINAL\]\nThanks for sharing this\./);
});

test("[[joke]] marks are protected like keep spans", async (t) => {
  const { json, seen, judgePrompt } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("E", ["E", "A", "B", "C", "D"]);
    return "You shipped it. [[k1]]";
  }, { Draft: "You shipped it. [[joke]]Keep this joke.[[/joke]]", Context: "a ship" });
  assert.equal(json.text.includes("Keep this joke."), true);
  assert.equal(json.text.includes("[[joke]]"), false);
  assert.equal(json.text.includes("[[k1]]"), false);
  for (const s of seen.filter((s) => s.model !== "z-ai/glm-5.3" && !s.reask)) {
    assert.match(s.user, /\[\[k1\]\]/);
    assert.equal(s.user.includes("Keep this joke."), false);
    assert.equal(s.user.includes("[[joke]]"), false);
  }
  assert.equal(judgePrompt.includes("[[joke]]"), false);
  assert.equal(judgePrompt.includes("[[k1]]"), false);
  assert.match(judgePrompt, /Keep this joke\./);
});

test("when every writer drops a span, one retry runs and the closest reply is repaired", async (t) => {
  const span = "Keep this joke.";
  const { result, json, texts, seen } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
    return "No token in this reply at all.";
  }, { Draft: `A point worth making. ${span}`, Context: "a point", keep: [span] });
  assert.notEqual(result.isError, true);
  assert.ok(json.text.includes(span), json.text);
  assert.equal(json.text.split(span).length - 1, 1);
  assert.ok(texts.some((x) => /protected span/.test(x) && /put back/.test(x)));
  for (const model of MODELS) assert.equal(seen.filter((s) => s.model === model).length, 2, model);
});

test("a repair that cannot meet maxChars throws and does not deliver", async (t) => {
  const span = "Keep this joke exactly as written please.";
  assert.ok([...span].length > 10);
  await assert.rejects(
    runHumanize(t, (body, ctx) => {
      if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
      return "No token here, just a long aside about the work.";
    }, { Draft: `A point. ${span}`, Context: "a point", keep: [span], maxChars: 10 }),
    /not charged/,
  );
});
