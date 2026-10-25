// humanize-comment v2.8: keep spans, ending, guidance cap, maxChars, writer-echo.
// Offline — every model call is a local stub. No network, no charge gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/tools.mjs";
import { ONE_THREAD_PREFIX, guidanceUnits, HUMANIZE_INPUT_CAPS, humanizeExtraProperties, sentencesOf, finalSentence, ensureEnding, recordReviewPrice, TITLE_OUTPUT_MAX, humanizeWriterRecord, rebuildHumanizeResult, collectSpans, writerNote, guardRetryPrompt, placeholderBudget, codePoints, MAX_CHARS_LIMIT, reinsertSpans, checkHumanizeInputs, forceRepair, moveQuestionToEnd, applyHumanizeFallback } from "../src/humanize.mjs";

const JOKE = "Guilty, I paid for ears I don't have.";
const MODELS = ["qwen/qwen3.8-27b-novelist", "deepseek/deepseek-v4.1-flash-1017", "TheDrummer/Cydonia-24B-v4.3", "qwen/qwen3.8-27b-antislop", "inception/mercury-3"];

function judge(winner, order, why = "ok") {
  return JSON.stringify({
    winner, text: "decider copy", why,
    ranked: order.map((w) => ({ writer: w, faithful: true, disqualified: false, reason: "ok" })),
  });
}

async function runHumanize(t, reply, args, opts = {}) {
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
  const registry = await loadTools({
    dirs: [dir],
    apiKey: opts.wallet ? undefined : "test-key",
    payment: opts.wallet || undefined,
    baseUrl: "http://127.0.0.1:" + srv.address().port,
    outDir: join(dir, "out"),
    log: () => {},
  });
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
    assert.deepEqual(tool.inputSchema.properties.title, humanizeExtraProperties().title);
    assert.equal(tool.inputSchema.properties.title.default, false);
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
  }, { Draft: "CI cut", Context: "a title", Guidance: "Rewrite the title.", title: true });
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
  assert.equal(seen.length, 6, "old-style call is 5 writers + the decider, the same 6 paid calls as #72");
  assert.equal(json.text, "rewrite by " + MODELS[0]);
  assert.equal(seen.filter((s) => s.messages.length > 2).length, 0, "no retry turn on an old-style call");
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
  assert.ok(texts.some((x) => /protected span/.test(x) && /put back/.test(x) && /decider confirmed/.test(x)));
  const writerCalls = seen.filter((s) => s.model !== "z-ai/glm-5.3");
  const retries = writerCalls.filter((s) => s.reask);
  assert.equal(retries.length, 3, "span retries share the 3-call re-ask budget");
  assert.equal(writerCalls.length, 8);
  const judges = seen.filter((s) => s.model === "z-ai/glm-5.3");
  assert.equal(judges.length, 2, "the repaired text is sent back to the decider");
  assert.ok(judges[1].user.includes(span));
});

test("protected text Ready?  Still waiting. stays byte for byte through repair and question moving", async () => {
  // Two spaces after the question mark. Collapsing them makes the final check miss the span.
  const span = "Ready?  Still waiting.";
  const spans = [{ id: 1, text: span }];
  assert.notEqual(span, span.replace(/ {2,}/g, " "));
  assert.equal(forceRepair(span, spans), span);
  assert.equal(forceRepair("  Hello  [[k1]]  there.  ", spans), `Hello ${span} there.`);
  assert.equal(moveQuestionToEnd(span, spans), span);
  assert.equal(moveQuestionToEnd(`Hello. ${span} Ship it now?`, spans), `Hello. ${span} Ship it now?`);
  assert.equal(ensureEnding(`Hello. ${span} Ship it now?`, "question", spans, `See this. ${span}`), `Hello. ${span} Ship it now?`);

  const record = Object.fromEntries(["A", "B", "C", "D", "E"].map((l) => [l, { model: l.toLowerCase() }]));
  const wf = { outputs: [{ nodeId: "judge", key: "out" }] };
  const text = `Hello. ${span} Ship it now?`;
  const delivered = { outputs: { out: JSON.stringify({ winner: "A", text, why: "ok", ranked: [{ writer: "A", model: "a", text, faithful: true, disqualified: false, reason: "ok" }] }) } };
  const kept = await applyHumanizeFallback(wf, delivered, record, {
    ending: "question", spans, draft: `See this. ${span}`, answered: { A: "a" }, dropped: {}, stash: [], guidance: "",
  });
  assert.equal(kept, null);
  assert.equal(JSON.parse(delivered.outputs.out).text.includes(span), true);

  let reviewed = null;
  const repaired = { outputs: { out: JSON.stringify({ winner: "ORIGINAL", text: "draft", why: "none", ranked: [] }) } };
  const fb = await applyHumanizeFallback(wf, repaired, record, {
    ending: "question", spans, draft: `See this. ${span}`, answered: {}, dropped: {}, guidance: "",
    stash: [{ letter: "A", model: "a", raw: "Hello [[k1]] Ship it now?", score: 2 }],
    reviewRepair: async (candidate) => { reviewed = candidate; return { ok: true }; },
  });
  assert.equal(fb && fb.error, undefined, fb && fb.error);
  assert.equal(reviewed.includes(span), true, reviewed);
  assert.equal(JSON.parse(repaired.outputs.out).text.includes(span), true);
});

test("a kept phrase of 0 cannot eat an internal marker or drop another phrase", () => {
  const first = "Alpha  Beta";
  const spans = [{ id: 1, text: first }, { id: 2, text: "0" }];
  const repaired = forceRepair("Hello [[k1]] and [[k2]] there.", spans);
  assert.equal(repaired.includes(first), true, repaired);
  assert.equal(repaired.includes("0"), true, repaired);
  assert.equal(/[\u0000\uE000-\uF8FF]|\[\[k/.test(repaired), false, repaired);
  assert.equal(repaired.split(first).length - 1, 1);
  const moved = moveQuestionToEnd(`Hello ${first} and 0 end?`, spans);
  assert.equal(moved.includes(first), true, moved);
  assert.equal(/[\uE000-\uF8FF]/.test(moved), false, moved);
});

test("keep_last and forceRepair keep protected spacing byte for byte, so delivery still succeeds", async () => {
  const spaced = "Ship  it.";
  const last = "Ready?  Still waiting.";
  const spans = [{ id: 1, text: spaced }, { id: 2, text: last }];
  assert.notEqual(spaced, spaced.replace(/ {2,}/g, " "));
  const repaired = forceRepair("  Note  [[k1]]  then  [[k2]]  ", spans);
  assert.equal(repaired.includes(spaced), true, repaired);
  assert.equal(repaired.includes(last), true, repaired);
  assert.equal(repaired.includes("Ship it."), false, repaired);
  const ended = ensureEnding(`Hello ${spaced} tail`, "keep_last", spans, `draft ${last}`);
  assert.ok(ended.endsWith(last), ended);
  assert.equal(ended.includes(spaced), true, ended);
  assert.equal(ended.includes("Ship it."), false, ended);

  const record = Object.fromEntries(["A", "B", "C", "D", "E"].map((l) => [l, { model: l.toLowerCase() }]));
  const wf = { outputs: [{ nodeId: "judge", key: "out" }] };
  const delivered = { outputs: { out: JSON.stringify({ winner: "ORIGINAL", text: "draft", why: "none", ranked: [] }) } };
  const fb = await applyHumanizeFallback(wf, delivered, record, {
    ending: "keep_last", spans, draft: `See ${spaced} ${last}`, answered: {}, dropped: {}, guidance: "",
    billing: "wallet", attempts: [{ paid: true, usd: 0.01, status: 200 }],
    stash: [{ letter: "A", model: "a", raw: "Note [[k1]] and [[k2]]", score: 4 }],
    reviewRepair: async () => ({ ok: true }),
  });
  assert.equal(fb && fb.error, undefined, fb && fb.error);
  const text = JSON.parse(delivered.outputs.out).text;
  assert.equal(text.includes(spaced), true, text);
  assert.equal(text.includes(last), true, text);
  assert.ok(text.endsWith(last), text);
});

test("forceRepair appends a missing span without trimming restored protected text", () => {
  const spans = [{ id: 1, text: "  One  " }, { id: 2, text: "Two" }];
  const repaired = forceRepair("[[k1]]", spans);
  assert.equal(repaired, "  One   Two");
  assert.equal(repaired.includes("  One  "), true);
  assert.equal(repaired.includes("Two"), true);
});

test("ensureEnding keep_last keeps protected leading spaces on every exit", () => {
  const spans = [{ id: 1, text: "  One  " }, { id: 2, text: "Two" }];
  assert.equal(ensureEnding("  One   Two", "keep_last", spans, ""), "  One   Two");
  // The ending span is missing: append it, and keep the other span's bytes.
  assert.equal(ensureEnding("  One  hello", "keep_last", spans, ""), "  One  hello Two");
  // The ending span has to move, and the other span's edge spaces stay.
  const moved = ensureEnding("Two and  One  ", "keep_last", spans, "");
  assert.ok(moved.endsWith("Two"), moved);
  assert.equal(moved.includes("  One  "), true, moved);
  // No question to move, and an empty last span: trimming stays outside the phrase.
  assert.equal(moveQuestionToEnd("  One  stays", [{ id: 1, text: "  One  " }]), "  One  stays");
  assert.equal(ensureEnding("  One  ", "keep_last", [{ id: 1, text: "  One  " }, { id: 2, text: "" }], ""), "  One  ");
  // A protected ending that itself has trailing spaces still counts as the ending.
  const edged = [{ id: 1, text: "  One  " }, { id: 2, text: "Two  " }];
  assert.equal(ensureEnding("  One   Two  ", "keep_last", edged, ""), "  One   Two  ");
});

test("keep_last keeps a final sentence that ends with a closing quote", () => {
  assert.deepEqual(sentencesOf('Please read the note here."'), ['Please read the note here."']);
  assert.equal(finalSentence('Please read the note here."'), 'Please read the note here."');
  assert.deepEqual(sentencesOf("Did you see it?'"), ["Did you see it?'"]);
  assert.deepEqual(sentencesOf('He left. "Hello there."'), ["He left.", '"Hello there."']);
  const asked = 'He asked "Ready?" Then shipped.';
  assert.deepEqual(sentencesOf(asked), ['He asked "Ready?"', "Then shipped."]);
  assert.equal(ensureEnding(asked, "question", [], asked), 'Then shipped. He asked "Ready?"');
  assert.deepEqual(sentencesOf("Don't stop. Go on."), ["Don't stop.", "Go on."]);
  assert.deepEqual(sentencesOf('He said "Go." She left.'), ['He said "Go."', "She left."]);
  const out = ensureEnding("Appreciate the writeup.", "keep_last", [], 'Thanks for the writeup. Please read the note here."');
  assert.ok(out.endsWith('here."'), out);
  assert.equal(out.includes('Please read the note here."'), true);
  const q = ensureEnding("Nice post.", "keep_last", [], "First line. Did you see it?'");
  assert.ok(q.endsWith("Did you see it?'"), q);
});

test("keep_last through the tool keeps a closing quote on the final sentence", async (t) => {
  const { json } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
    return "Appreciate the writeup.";
  }, { Draft: 'Thanks for the writeup. Please read the note here."', Context: "a note", ending: "keep_last" });
  assert.ok(json.text.endsWith('here."'), json.text);
  assert.equal(json.text.includes('Please read the note here."'), true);
  const { json: asked } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("B", ["B", "A", "C", "D", "E"]);
    return "Nice post.";
  }, { Draft: "First line. Did you see it?'", Context: "a note", ending: "keep_last" });
  assert.ok(asked.text.endsWith("Did you see it?'"), asked.text);
});

test("impossible keep constraints are rejected before any paid call", async (t) => {
  let hits = 0;
  await assert.rejects(
    runHumanize(t, () => { hits++; return "x"; }, { Draft: "hello there", Context: "a note", keep: ["missing-span-xyz"] }),
    (e) => e.mcpCode === -32602 && /not in the draft/.test(e.message) && /Nothing was charged/.test(e.message) && !/you were not charged/.test(e.message),
  );
  assert.equal(hits, 0);
  hits = 0;
  await assert.rejects(
    runHumanize(t, () => { hits++; return "x"; }, { Draft: "alpha and beta are here", Context: "a note", keep: ["alpha", "beta"], maxChars: 8 }),
    (e) => e.mcpCode === -32602 && /smaller than the protected text \(9 characters\)/.test(e.message) && /Nothing was charged/.test(e.message),
  );
  assert.equal(hits, 0);
});

const ACCUSATION = "You stole $100000 from your employer.";

function unfaithful(letter) {
  return JSON.stringify({
    winner: "ORIGINAL",
    text: "original",
    why: "adds an accusation",
    ranked: ["A", "B", "C", "D", "E"].map((w) => ({ writer: w, faithful: w === letter ? false : true, disqualified: true, reason: w === letter ? "adds a claim" : "missing" })),
  });
}

test("a repaired rewrite that adds an accusation is rejected by the decider and not delivered", async (t) => {
  const span = "Keep this joke.";
  const judgeUsers = [];
  await assert.rejects(
    runHumanize(t, (body, ctx) => {
      if (ctx.judge) {
        judgeUsers.push(ctx.user);
        if (ctx.user.includes(ACCUSATION)) return unfaithful("A");
        return judge("A", ["A", "B", "C", "D", "E"]);
      }
      return ACCUSATION;
    }, { Draft: `A point worth making. ${span}`, Context: "a point", keep: [span] }),
    (e) => {
      assert.match(e.message, /faithfulness and safety check/);
      assert.match(e.message, /API key/);
      assert.doesNotMatch(e.message, /you were not charged/);
      assert.equal(e.message.includes(ACCUSATION), false);
      return true;
    },
  );
  assert.ok(judgeUsers.some((u) => u.includes(ACCUSATION)), "the decider was shown the repaired accusation");
  assert.equal(judgeUsers.filter((u) => u.includes(ACCUSATION)).length, 1);
});

test("ending question keeps a closing quote attached to its question", async (t) => {
  const asked = 'He asked "Ready?" Then shipped.';
  const { json } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
    return asked;
  }, { Draft: asked, Context: "a line", ending: "question" });
  assert.equal(json.text, 'Then shipped. He asked "Ready?"');
});

test("a title dropped for length is not repaired into a delivery", async (t) => {
  const span = "0123456789abcde";
  assert.equal(TITLE_OUTPUT_MAX + [...span].length, 235);
  const long = "x".repeat(305);
  await assert.rejects(
    runHumanize(t, (body, ctx) => {
      if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
      return long;
    }, { Draft: `A point worth making. ${span}`, Context: "a point", keep: [span], title: true }),
    (e) => {
      assert.equal(e.message.includes(long), false);
      assert.doesNotMatch(e.message, /you were not charged/);
      return true;
    },
  );
});

test("an unpriced review is unknown on the call and in the total, and an explicit 0 stays exact", () => {
  const state = { reviewUsd: 0, costUnknown: false };
  const rec = { usd: 0.004, paid: true, priceKnown: true };
  recordReviewPrice(state, rec, { known: false, usd: null, paidUsd: 0.004 });
  assert.equal(rec.usd, null);
  assert.equal(rec.priceKnown, false);
  assert.equal(state.costUnknown, true);
  assert.equal(state.reviewUsd, 0.004);
  const zero = { reviewUsd: 0, costUnknown: false };
  const rec0 = { usd: null, priceKnown: false };
  recordReviewPrice(zero, rec0, { known: true, usd: 0, paidUsd: 0.004 });
  assert.equal(rec0.usd, 0);
  assert.equal(rec0.priceKnown, true);
  assert.equal(zero.costUnknown, false);
  assert.equal(zero.reviewUsd, 0);
  const missing = { reviewUsd: 0, costUnknown: false };
  const recM = { usd: 0, priceKnown: true };
  recordReviewPrice(missing, recM, { known: false, usd: null, paidUsd: null });
  assert.equal(recM.usd, null);
  assert.equal(recM.priceKnown, false);
  assert.equal(missing.costUnknown, true);
  assert.equal(missing.reviewUsd, 0);
});

test("a later keep that swallows placeholders stays inside the priced note and retry", () => {
  // 87 "k"s, then keep "[[k" twice. "[[k" is not in the original draft, so it must
  // not match inside the [[kN]] placeholders, and none of the 87 "k"s may be dropped.
  // Matching inside those placeholders used to push the note and the retry 600
  // characters over the 201-placeholder allowance.
  const draft = "k".repeat(87);
  const keep = ["k", "[[k", "[[k"];
  const { writerDraft, spans } = collectSpans(draft, keep);
  const budget = placeholderBudget();
  const note = writerNote(spans, "keep_last", MAX_CHARS_LIMIT);
  const guard = guardRetryPrompt(["keep"], { spans });
  assert.equal(spans.length, 87);
  assert.ok(spans.every((s) => s.text === "k" && s.source === "keep"));
  assert.equal(writerDraft, spans.map((s) => `[[k${s.id}]]`).join(""));
  assert.equal(spans.some((s) => s.text === "[[k"), false);
  assert.ok(codePoints(note) <= codePoints(budget.note), `note is ${codePoints(note)} chars, priced allowance is ${codePoints(budget.note)}`);
  assert.ok(codePoints(guard) <= codePoints(budget.guard), `retry is ${codePoints(guard)} chars, priced allowance is ${codePoints(budget.guard)}`);
  assert.ok(codePoints(writerDraft) <= HUMANIZE_INPUT_CAPS.Draft);
});

test("keep \"1\" does not match inside [[k1]] or drop the disclosure", async (t) => {
  const disclosure = "I am an AI agent.";
  const draft = "I am an AI agent. Version 1.";
  const { writerDraft, spans } = collectSpans(draft, [disclosure, "1"]);
  assert.equal(writerDraft, "[[k1]] Version [[k2]].");
  assert.deepEqual(spans.map((s) => s.text), [disclosure, "1"]);
  const { json, seen, judgePrompt } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
    return "Released as [[k1]] Version [[k2]].";
  }, { Draft: draft, Context: "a release note", keep: [disclosure, "1"] });
  assert.equal(json.text.includes(disclosure), true, json.text);
  assert.equal(json.text.includes("Version 1."), true, json.text);
  assert.equal(json.text.includes("[[k"), false, json.text);
  for (const s of seen.filter((s) => s.model !== "z-ai/glm-5.3" && !s.reask)) {
    assert.match(s.user, /\[\[k1\]\] Version \[\[k2\]\]\./);
    assert.equal(s.user.includes(disclosure), false);
    assert.equal(s.user.includes("[[k[[k"), false);
  }
  assert.equal(judgePrompt.includes(disclosure), true);
  assert.equal(judgePrompt.includes("[[k"), false);
});

test("crossing keeps are merged so cdef is not dropped", async (t) => {
  const draft = "abcdef";
  const { writerDraft, spans } = collectSpans(draft, ["abcd", "cdef"]);
  assert.equal(writerDraft, "[[k1]]");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, "abcdef");
  const { json, seen } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
    return "Changed [[k1]].";
  }, { Draft: draft, Context: "a note", keep: ["abcd", "cdef"] });
  assert.equal(json.text, "Changed abcdef.");
  assert.equal(json.text.includes("cdef"), true, json.text);
  assert.notEqual(json.text, "Changed abcd.");
  assert.equal(seen.filter((s) => s.reask).length, 0);
});

test("a keep inside a joke mark is restored without the joke wrappers", async (t) => {
  const draft = "[[joke]]Funny.[[/joke]]";
  const { writerDraft, spans } = collectSpans(draft, ["Funny."]);
  assert.equal(writerDraft, "[[k1]]");
  assert.deepEqual(spans.map((s) => s.text), ["Funny."]);
  const { json, seen, judgePrompt } = await runHumanize(t, (body, ctx) => {
    if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
    return "Changed [[k1]]";
  }, { Draft: draft, Context: "a note", keep: ["Funny."] });
  assert.equal(json.text, "Changed Funny.");
  assert.equal(json.text.includes("[[joke]]"), false, json.text);
  assert.equal(json.text.includes("[[/joke]]"), false, json.text);
  assert.equal(judgePrompt.includes("[[joke]]"), false);
  assert.equal(seen.length, 6);
});

test("crossing keeps are measured by the merged span, so maxChars 6 is allowed", async (t) => {
  const draft = "abcdef";
  const keep = ["abcd", "cdef"];
  const { spans } = collectSpans(draft, keep);
  assert.equal(spans.map((s) => s.text).join(""), "abcdef");
  assert.equal(codePoints(spans.map((s) => s.text).join("")), 6);
  assert.doesNotThrow(() => checkHumanizeInputs({ Draft: draft, Context: "a note", keep, maxChars: 6 }));
  let hits = 0;
  const { json } = await runHumanize(t, (body, ctx) => {
    hits++;
    if (ctx.judge) return judge("A", ["A", "B", "C", "D", "E"]);
    return "[[k1]]";
  }, { Draft: draft, Context: "a note", keep, maxChars: 6 });
  assert.equal(hits, 6, "the merged 6 characters must not be refused before any model call");
  assert.equal(json.text, "abcdef");
  assert.equal(json.text.includes("cdef"), true);
});

test("a draft marker [[k2]] is restored in one pass and refused before quoting", async (t) => {
  const spans = [{ id: 1, text: "[[k2]]" }, { id: 2, text: "x" }];
  assert.equal(reinsertSpans("Changed [[k1]] [[k2]].", spans), "Changed [[k2]] x.");
  let hits = 0;
  await assert.rejects(
    runHumanize(t, () => { hits++; return "Changed [[k1]] [[k2]]."; }, { Draft: "[[k2]] x", Context: "a note", keep: ["[[k2]]", "x"] }),
    (e) => e.mcpCode === -32602 && /placeholder marker \[\[k2\]\]/.test(e.message) && /Nothing was charged/.test(e.message),
  );
  assert.equal(hits, 0, "the marker collision must not reach 5 writers and the judge");
});

test("maxChars counts every copy of a keep span and refuses before any model call", async (t) => {
  let hits = 0;
  const piece = "z";
  await assert.rejects(
    runHumanize(t, () => { hits++; return piece; }, { Draft: piece.repeat(10), Context: "a note", keep: [piece], maxChars: 1 }),
    (e) => e.mcpCode === -32602 && /smaller than the protected text \(10 characters\)/.test(e.message) && /Nothing was charged/.test(e.message),
  );
  assert.equal(hits, 0, "ten copies must not reach the 5 writers, 3 retries, and the judge");
});

test("a keep span repeated through the whole draft is refused before any model call", async (t) => {
  let hits = 0;
  await assert.rejects(
    runHumanize(t, () => { hits++; return "x"; }, { Draft: "x".repeat(1500), Context: "a note", keep: ["x"] }),
    (e) => e.mcpCode === -32602 && /placeholders are \d+ characters, above the 1500-character cap/.test(e.message) && /Nothing was charged/.test(e.message),
  );
  assert.equal(hits, 0, "5 writers, retries, and ranking must not run before the refusal");
});

test("the decider prompt is the writers' own outputs, with no MCP rebuild (#98)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { Workflow } = await import("nanoodle");
  const graphText = await readFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), "utf8");
  const graph = JSON.parse(graphText);
  const lines = {
    "qwen/qwen3.8-27b-novelist": "NOVELIST-LINE",
    "deepseek/deepseek-v4.1-flash-1017": "DEEPSEEK-LINE",
    "TheDrummer/Cydonia-24B-v4.3": "CYDONIA-LINE",
    "qwen/qwen3.8-27b-antislop": "ANTISLOP-LINE",
    "inception/mercury-3": "MERCURY-LINE",
  };
  const labels = {
    "qwen/qwen3.8-27b-novelist": "A",
    "deepseek/deepseek-v4.1-flash-1017": "B",
    "TheDrummer/Cydonia-24B-v4.3": "C",
    "qwen/qwen3.8-27b-antislop": "D",
    "inception/mercury-3": "E",
  };
  const nodes = { A: "w-a", B: "w-b", C: "w-c", D: "w-d", E: "w-e" };
  const rankedIds = {
    winner: "C",
    text: "decider paraphrase, not a writer line",
    why: "ranked by id",
    ranked: ["C", "A", "B", "D", "E"].map((w) => ({ writer: w, faithful: true, disqualified: false, reason: "ok" })),
  };
  let judgeUser = "";
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const user = (body.messages || []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
    if (body.model === "z-ai/glm-5.3") judgeUser = user;
    const content = lines[body.model] || JSON.stringify(rankedIds);
    return new Response(JSON.stringify({ choices: [{ message: { content } }], x_nanogpt_pricing: { costUsd: 0.0001 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const wf = Workflow.fromJSON(graphText, { apiKey: "test-key", baseUrl: "http://nano.test", fetch });
  const result = await wf.run({ Draft: "Draft line.", Context: "Context line.", Guidance: "Guidance line." });
  for (const [model, line] of Object.entries(lines)) {
    assert.ok(judgeUser.includes(`[${labels[model]}] ${model}\n${line}`), `${model} missing from decider prompt`);
  }
  const returned = JSON.parse(result.get("Decider (GLM-5.3)"));
  assert.deepEqual(returned, rankedIds, "the graph returns the decider's ranked ids, not copied writer text");
  for (const row of returned.ranked) assert.equal(row.text, undefined);
  for (const [model, line] of Object.entries(lines)) {
    const id = nodes[labels[model]];
    assert.equal(result.nodes[id].status, "done");
    assert.equal(result.nodes[id].out.text, line, `${id} keeps the writer's own text`);
  }
  const record = humanizeWriterRecord(graph);
  assert.equal(rebuildHumanizeResult(wf, result, record), null);
  const adapted = JSON.parse(result.get("Decider (GLM-5.3)"));
  assert.equal(adapted.winner, "C");
  assert.equal(adapted.text, "CYDONIA-LINE", "the consumer adapter attaches the winning writer's text");
  for (const [letter, id] of Object.entries(nodes)) {
    const row = adapted.ranked.find((r) => r.writer === letter);
    assert.equal(row.text, result.nodes[id].out.text);
    assert.equal(row.model, record[letter].model);
  }
});

test("a wallet caller who already paid is not told they were not charged", async (t) => {
  const span = "Keep this joke.";
  await assert.rejects(
    runHumanize(t, (body, ctx) => {
      if (ctx.judge) return ctx.user.includes(ACCUSATION) ? unfaithful("A") : judge("A", ["A", "B", "C", "D", "E"]);
      return ACCUSATION;
    }, { Draft: `A point worth making. ${span}`, Context: "a point", keep: [span] }, { wallet: async () => {} }),
    (e) => {
      assert.match(e.message, /wallet/);
      assert.match(e.message, /not refunded/);
      assert.doesNotMatch(e.message, /you were not charged/);
      assert.doesNotMatch(e.message, /API key/);
      return true;
    },
  );
});
