// The job-brief format the Agent Market worker accepts (src/market/brief.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrief, BriefError, BRIEF_TEMPLATE, fencedBlocks, splitPlainBrief, parseSeconds, resolveFields } from "../src/market/brief.mjs";

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

test("splitPlainBrief: \"Name: value\" lines set a listing workflow's other named inputs", () => {
  const S = ["Style"];
  assert.deepEqual(splitPlainBrief("A wistful song about the singularity.\nStyle: 80s trip-hop bands that have a female singer", S),
    { main: "A wistful song about the singularity.", fields: { Style: "80s trip-hop bands that have a female singer" } });
  // Case, spacing, a list marker, Markdown bold and a full-width colon are all accepted.
  for (const line of ["style : slow country ballad", "- Style: slow country ballad", "**Style:** slow country ballad", "**STYLE**: slow country ballad", "Style： slow country ballad"]) {
    assert.deepEqual(splitPlainBrief(`${line}\r\nA song about rain`, S), { main: "A song about rain", fields: { Style: "slow country ballad" } }, line);
  }
  // The first line for a name wins and later ones are dropped; unknown names stay in the text.
  assert.deepEqual(splitPlainBrief("Style: funk\nMood: happy\nstyle: jazz\nA song", S), { main: "Mood: happy\nA song", fields: { Style: "funk" } });
  // Nothing after the colon, or a name in the middle of a sentence, is ordinary text.
  assert.deepEqual(splitPlainBrief("Style:\njust text", S), { main: "Style:\njust text", fields: {} });
  assert.deepEqual(splitPlainBrief("A song about my cat. Style: funk", S), { main: "A song about my cat. Style: funk", fields: {} });
  // Only field lines: the main text is empty (the worker then falls back to the job title).
  assert.deepEqual(splitPlainBrief("Style: funk", S), { main: "", fields: { Style: "funk" } });
  // A workflow with no other named input: the brief is untouched.
  assert.deepEqual(splitPlainBrief("  Style: funk\nA song  ", []), { main: "Style: funk\nA song", fields: {} });
  assert.deepEqual(splitPlainBrief(undefined, S), { main: "", fields: {} });
  // Several names, with spaces in a name.
  assert.deepEqual(splitPlainBrief("Art style: ink\nMain colour: teal\nA fox", ["Art style", "Main colour"]), { main: "A fox", fields: { "Art style": "ink", "Main colour": "teal" } });
});

test("parseSeconds: the ways a buyer writes a length", () => {
  const cases = [["90", 90], ["90s", 90], ["90 seconds", 90], ["45 secs", 45], ["2 min", 120], ["2 minutes", 120], ["4 mins", 240], ["2m30s", 150],
    ["2 min 30 sec", 150], ["3 min 20 s", 200], ["2:30", 150], ["0:45", 45], ["about 3 minutes", 180], ["1.5 minutes", 90], ["1,5 min", 90], ["2.5m", 150],
    ["3", 180], ["10", 600], ["11", 11], ["120", 120], ["0", 1], ["one minute", null], ["long", null], ["", null], [undefined, null]];
  for (const [text, want] of cases) assert.equal(parseSeconds(text), want, JSON.stringify(text));
});

test("resolveFields: a seconds field is read, clamped, or picked the same way every time for one job", () => {
  const specs = { Duration: { seconds: { min: 30, max: 240, defaultMin: 120, defaultMax: 240 } } };
  assert.deepEqual(resolveFields({ Style: "funk", Duration: "1 minute" }, specs, "job"),
    { inputs: { Style: "funk", Duration: "60 seconds" }, set: ["Style", "Duration"], notes: ["Duration: aiming for about 60 seconds, as you asked."] });
  assert.deepEqual(resolveFields({ Duration: "10 minutes" }, specs, "job"),
    { inputs: { Duration: "240 seconds" }, set: ["Duration"], notes: ["Duration: you asked for 600 seconds; this listing does 30 to 240, so it aims for about 240 seconds."] });
  assert.deepEqual(resolveFields({ Duration: "5 seconds" }, specs, "job").inputs, { Duration: "30 seconds" });
  // None given: picked between the defaults, the same for the same job, and not the same for every job.
  const a = resolveFields({}, specs, "job-1"), again = resolveFields({}, specs, "job-1");
  assert.deepEqual(a, again);
  assert.deepEqual(a.set, []);
  assert.match(a.notes[0], /^Duration: none given, so it aims for about \d+ seconds \(picked between 120 and 240\)\.$/);
  const picks = new Set();
  for (let i = 0; i < 2000; i++) picks.add(parseInt(resolveFields({}, specs, `job-${i}`).inputs.Duration, 10));
  assert.ok(Math.min(...picks) >= 120 && Math.max(...picks) <= 240 && picks.size > 100, `${Math.min(...picks)}..${Math.max(...picks)} (${picks.size} values)`);
  // Unreadable: treated as not given, and the buyer is told. Their text is cut short.
  const u = resolveFields({ Duration: "as long as it takes, really, no hurry at all my friend" }, specs, "job-1");
  assert.equal(u.inputs.Duration, a.inputs.Duration);
  assert.deepEqual(u.set, []);
  assert.match(u.notes[0], /^Duration: "as long as it takes, really, no hurry at" could not be read as a length/);
  // No specs: fields pass through untouched.
  assert.deepEqual(resolveFields({ Style: "funk" }, {}, "x"), { inputs: { Style: "funk" }, set: ["Style"], notes: [] });
  assert.deepEqual(resolveFields(undefined, undefined, "x"), { inputs: {}, set: [], notes: [] });
});
