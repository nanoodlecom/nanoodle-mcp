// The Agent Market worker running INSIDE the MCP server (bin/nanoodle-mcp.mjs --serve),
// where it pays NanoGPT the way the server does. Against the market and NanoGPT stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMarketMock, MOCK_TOKEN } from "./fixtures/market-mock.mjs";
import { nanoGptMock, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";
import { freePort } from "../scripts/near-simulate.mjs";
import { createWorkflowRunner } from "../src/market/runner.mjs";
import http from "node:http";
import { readConfig, readDefaultWorkflow, createNotifier, NOTIFY_LINES, MarketConfigError } from "../src/market/service.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "nanoodle-mcp.mjs");
const NANO_KEY = "nanogpt-test-key-do-not-log";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serve(env) {
  const dir = mkdtempSync(join(tmpdir(), "market-in-server-"));
  const graphs = join(dir, "noodles"); mkdirSync(graphs);
  writeFileSync(join(graphs, "idea-poster.json"), JSON.stringify(WORKED_GRAPH));
  const def = join(dir, "default.json"); writeFileSync(def, JSON.stringify({ ...WORKED_GRAPH, name: "Idea to image" }));
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, "--graphs", graphs, "--out", join(dir, "out"), "--serve", `127.0.0.1:${port}`], {
    env: { PATH: process.env.PATH, HOME: dir, NANOGPT_API_KEY: NANO_KEY, MARKET_STATE_DIR: join(dir, "market-state"), MARKET_DEFAULT_GRAPH: def, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  const until = async (re, ms = 30_000) => {
    const t0 = Date.now();
    while (!re.test(stderr)) {
      if (child.exitCode !== null) throw new Error("server exited:\n" + stderr);
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${re}:\n${stderr}`);
      await sleep(25);
    }
  };
  await until(/MCP over HTTP on/);
  const exited = new Promise((r) => child.once("exit", (code, sig) => r({ code, sig })));
  return { port, until, stderr: () => stderr, child, exited, kill: () => { child.kill("SIGKILL"); return exited; } };
}

test("the worker runs inside the server: a plain-language hire is delivered; SIGTERM drains and exits 0", { timeout: 90_000 }, async () => {
  const nano = nanoGptMock(); await nano.listen();
  const m = createMarketMock(); await m.listen();
  const pings = [];
  const hook = http.createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { pings.push(JSON.parse(b).text); res.end("ok"); }); });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/services/T000/secret-path`;
  const srv = await serve({ NANOGPT_BASE_URL: nano.url, MARKET_BASE_URL: m.url, MARKET_AGENT_TOKEN: MOCK_TOKEN, MARKET_JOB_BUDGET_USD: "0.5", MARKET_LISTING_PRICE_USD: "1", MARKET_POLL_SECONDS: "1", MARKET_NOTIFY_URL: hookUrl });
  try {
    await srv.until(/market worker: polling http/);
    assert.match(srv.stderr(), /market worker: plain-language briefs run the default workflow "Idea to image"/);
    const id = m.hire({ description: "A poster for a small coffee shop opening on Saturday." });
    const t0 = Date.now();
    while (m.rows.get(id).assignment.status !== "submitted") {
      if (Date.now() - t0 > 70_000) throw new Error("not delivered:\n" + srv.stderr());
      await sleep(200);
    }
    assert.match(m.rows.get(id).versions[0].markdown, /ran its default workflow \(Idea to image\)/);
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/`)).status, 200, "the MCP server still serves");
    assert.ok(!srv.stderr().includes(MOCK_TOKEN) && !srv.stderr().includes(NANO_KEY), "no secret in the log");
    // The operator hears about the purchase and the delivery; the webhook URL is never logged.
    for (let i = 0; i < 100 && pings.length < 2; i++) await sleep(50);
    assert.ok(pings.some((t) => /^nanoodle market: assignment \w+: new hire "nanoodle workflow" for 1 USD$/.test(t)), JSON.stringify(pings));
    assert.ok(pings.some((t) => /: delivered$/.test(t)), JSON.stringify(pings));
    assert.ok(!srv.stderr().includes("secret-path"), "the webhook URL is not logged");
    assert.match(srv.stderr(), /hires and outcomes are also posted to MARKET_NOTIFY_URL/);
    srv.child.kill("SIGTERM");
    assert.deepEqual(await srv.exited, { code: 0, sig: null });
    assert.match(srv.stderr(), /market worker: SIGTERM: no new jobs/);
  } finally { if (srv.child.exitCode === null) await srv.kill(); await m.close(); await nano.close(); hook.closeAllConnections?.(); await new Promise((r) => hook.close(r)); }
});

test("several listings inside the server (MARKET_AGENTS_FILE): each hire runs on its listing, the webhook names it, SIGTERM drains all", { timeout: 90_000 }, async () => {
  const nano = nanoGptMock(); await nano.listen();
  const TOKEN2 = "aat_" + "fedcba9876543210".repeat(2);
  const m = createMarketMock({ handle: "img-one", priceAmount: "0.50" }); await m.listen();
  m.addAgent({ handle: "wf-any", token: TOKEN2, priceAmount: "1.00" });
  const dir = mkdtempSync(join(tmpdir(), "market-in-server-catalog-"));
  const graph = join(dir, "img.json"); writeFileSync(graph, JSON.stringify({ ...WORKED_GRAPH, name: "Idea to image" }));
  writeFileSync(join(dir, "img-one.token"), MOCK_TOKEN, { mode: 0o600 });
  writeFileSync(join(dir, "wf-any.token"), TOKEN2, { mode: 0o600 });
  const catalog = join(dir, "catalog.json");
  writeFileSync(catalog, JSON.stringify({ agents: [
    { handle: "img-one", tokenFile: join(dir, "img-one.token"), graph, custom: false },
    { handle: "wf-any", tokenFile: join(dir, "wf-any.token"), graph: null, custom: true, priceUsd: 1 },
    { handle: "not-yet", tokenFile: join(dir, "not-yet.token"), graph: null, custom: true, priceUsd: 1 },
  ] }));
  const pings = [];
  const hook = http.createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { pings.push(JSON.parse(b).text); res.end("ok"); }); });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/services/T000/secret-path`;
  const srv = await serve({ NANOGPT_BASE_URL: nano.url, MARKET_BASE_URL: m.url, MARKET_AGENTS_FILE: catalog, MARKET_POLL_SECONDS: "1", MARKET_NOTIFY_URL: hookUrl });
  try {
    await srv.until(/market worker: polling http\S+ every 1 s for 2 listings \(img-one, wf-any\)/);
    assert.match(srv.stderr(), /market worker: \[not-yet\] skipped: no token file/);
    assert.match(srv.stderr(), /market worker: \[img-one\] price \$0\.50 \(from the market\); per-job budget \$0\.47/);
    assert.match(srv.stderr(), /market worker: the agents file replaces MARKET_DEFAULT_GRAPH; it is ignored/);
    const a = m.hire({ agent: "img-one", description: "A poster for a small coffee shop opening on Saturday." });
    const b = m.hire({ agent: "wf-any", description: `Run mine\n\n\`\`\`nanoodle\n${JSON.stringify({ graph: WORKED_GRAPH, inputs: { Idea: "a lighthouse" } })}\n\`\`\`\n` });
    const t0 = Date.now();
    while (m.rows.get(a).assignment.status !== "submitted" || m.rows.get(b).assignment.status !== "submitted") {
      if (Date.now() - t0 > 70_000) throw new Error("not delivered:\n" + srv.stderr());
      await sleep(200);
    }
    for (let i = 0; i < 100 && pings.filter((t) => /: delivered$/.test(t)).length < 2; i++) await sleep(50);
    assert.ok(pings.some((t) => /^nanoodle market: \[img-one\] assignment \w+: delivered$/.test(t)), JSON.stringify(pings));
    assert.ok(pings.some((t) => /^nanoodle market: \[wf-any\] assignment \w+: delivered$/.test(t)), JSON.stringify(pings));
    assert.ok(!srv.stderr().includes(MOCK_TOKEN) && !srv.stderr().includes(TOKEN2) && !srv.stderr().includes(NANO_KEY) && !srv.stderr().includes("secret-path"));
    srv.child.kill("SIGTERM");
    assert.deepEqual(await srv.exited, { code: 0, sig: null });
    assert.deepEqual(m.violations, []);
  } finally { if (srv.child.exitCode === null) await srv.kill(); await m.close(); await nano.close(); hook.closeAllConnections?.(); await new Promise((r) => hook.close(r)); }
});

test("a broken market setting leaves the MCP server serving with the worker off", { timeout: 60_000 }, async () => {
  const nano = nanoGptMock(); await nano.listen();
  // budget above what a $0.10 hire pays after the fee
  const srv = await serve({ NANOGPT_BASE_URL: nano.url, MARKET_AGENT_TOKEN: MOCK_TOKEN, MARKET_JOB_BUDGET_USD: "0.5", MARKET_LISTING_PRICE_USD: "0.10" });
  try {
    await srv.until(/market worker: OFF — --budget-usd 0\.5 is above what a \$0\.1 hire pays you/);
    await srv.until(/the MCP server is serving normally/);
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/`)).status, 200);
  } finally { await srv.kill(); await nano.close(); }
});

test("configuration: a wallet-funded host needs no NanoGPT key; a runner takes a key or a payment callback", () => {
  const env = { MARKET_AGENT_TOKEN: MOCK_TOKEN, MARKET_JOB_BUDGET_USD: "0.5", NANOGPT_API_KEY: "" };
  assert.throws(() => readConfig([], env), (e) => e instanceof MarketConfigError && /no NanoGPT key/.test(e.message));
  const cfg = readConfig([], env, { needKey: false });
  assert.equal(cfg.apiKey, null);
  assert.equal(cfg.budgetUsd, 0.5);
  assert.throws(() => createWorkflowRunner({ budgetUsd: 0.5 }), /API key or an x402 payment callback/);
  assert.ok(createWorkflowRunner({ budgetUsd: 0.5, payment: async () => {} }));
  assert.throws(() => readConfig(["--help"], env), (e) => e instanceof MarketConfigError && e.help === true);
});

test("notifications: which lines are sent, buyer text is escaped, a dead webhook never throws", async () => {
  for (const l of ['assignment ab12: new hire "x" for 1 USD', "assignment ab12: delivered", "assignment ab12: declined (rejected, NO_REQUEST); the buyer is refunded in full",
    "assignment ab12: run failed (boom); handing it back", "assignment ab12: NEEDS OPERATOR — start refused (x)", "stopped: 401; no new polls"]) assert.ok(NOTIFY_LINES.test(l), l);
  for (const l of ["assignment ab12: running the workflow", "polling https://market.near.ai every 45 s", "assignment ab12: accepted — estimated cost $0.01"]) assert.ok(!NOTIFY_LINES.test(l), l);
  const sent = [];
  const notify = createNotifier({ url: "https://hooks.example.test/x", fetch: async (u, init) => { sent.push(JSON.parse(init.body)); return new Response("ok"); } });
  notify('assignment ab12: new hire "<!channel> & <https://evil.test|click>" for 1 USD');
  await sleep(20);
  assert.deepEqual(sent, [{ text: 'nanoodle market: assignment ab12: new hire "&lt;!channel&gt; &amp; &lt;https://evil.test|click&gt;" for 1 USD' }]);
  const logs = [];
  createNotifier({ url: "https://hooks.example.test/secret", fetch: async () => { throw new TypeError("fetch failed"); }, log: (l) => logs.push(l) })("x: delivered");
  createNotifier({ url: "https://hooks.example.test/secret", fetch: async () => new Response("no", { status: 404 }), log: (l) => logs.push(l) })("x: delivered");
  await sleep(20);
  assert.deepEqual(logs.sort(), ["notification not delivered (HTTP 404)", "notification not delivered (TypeError)"]);
  assert.throws(() => readConfig([], { MARKET_AGENT_TOKEN: MOCK_TOKEN, MARKET_JOB_BUDGET_USD: "0.5", NANOGPT_API_KEY: "k", MARKET_NOTIFY_URL: "http://example.test/x" }), /must be an https URL/);
});

test("the hosted song workflow: the brief goes to Song idea, Style is a settable field; the lyrics are delivered as well as the song", () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "market-sing.json");
  assert.throws(() => readDefaultWorkflow(file), (e) => e instanceof MarketConfigError && /3 named text nodes/.test(e.message));
  const d = readDefaultWorkflow(file, "Song idea");
  assert.equal(d.label, "Idea to song");
  assert.equal(d.inputName, "Song idea");
  assert.deepEqual(d.fieldNames, ["Style", "Duration"]);
  const byName = Object.fromEntries(d.graph.nodes.filter((n) => n.name).map((n) => [n.name, n]));
  assert.equal(byName["Song idea"].fields.text, "");
  // With no "Style:" line the workflow picks a style itself; no band is named anywhere in the graph.
  assert.equal(byName.Style.fields.text, "No style given. Choose a style that fits the song idea.");
  assert.ok(!("Preferred bands" in byName));
  assert.doesNotMatch(JSON.stringify(d.graph), /Portishead|Massive Attack|Tricky/);
  assert.equal(byName["Idea + style"].fields.sep, "\n\nStyle:\n");
  assert.ok(d.graph.links.some((l) => l.from.node === byName.Style.id && l.to.node === byName["Idea + style"].id));
  // Duration is a text input too: MiniMax Music 3 takes no length setting, so the target
  // length reaches the lyric writer and the arranger as text, joined after idea and style.
  assert.equal(byName.Duration.fields.text, "180 seconds");
  const len = byName["Idea + style + length"];
  assert.equal(len.fields.sep, "\n\nTarget length:\n");
  assert.ok(d.graph.links.some((l) => l.from.node === byName["Idea + style"].id && l.to.node === len.id && l.to.port === "a"));
  assert.ok(d.graph.links.some((l) => l.from.node === byName.Duration.id && l.to.node === len.id && l.to.port === "b"));
  assert.ok(d.graph.links.some((l) => l.from.node === len.id && l.to.node === byName["Write lyrics"].id));
  assert.ok(!d.graph.links.some((l) => l.from.node === byName["Idea + style"].id && l.to.node !== len.id), "idea + style is only read through the length join");
  assert.ok(!("duration" in byName.Sing.fields), "no duration field is sent to the music model");
  assert.equal(byName.Sing.type, "music");
  // "Lyrics" is a sink (nothing reads it), so the engine returns it as an output.
  assert.equal(byName.Lyrics.type, "join");
  assert.ok(d.graph.links.some((l) => l.to.node === byName.Lyrics.id && l.from.node === byName["Write lyrics"].id));
  assert.ok(!d.graph.links.some((l) => l.from.node === byName.Lyrics.id));
});
