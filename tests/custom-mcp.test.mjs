import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { nanoNode } from "../scripts/dual-simulate.mjs";
import { freePort } from "../scripts/near-simulate.mjs";
import { USDC_CONTRACTS } from "../src/near/ft.mjs";
import { createFakeChain, nanoGptMock, throwawayNearKey, WORKED_GRAPH } from "./fixtures/near-fake-chain.mjs";

const secret = prefix => prefix + randomBytes(32).toString("hex");
const owner = () => secret("nmo_");
const client = () => secret("nmc_");
const read = async response => ({ status: response.status, data: await response.json(), headers: response.headers });
const names = response => response.data.result.tools.map(tool => tool.name);
const input = { Idea: "A lighthouse over a quiet bay" };
const workflow = { name: "my-poster", description: "Make a poster privately", graph: WORKED_GRAPH };
const config = { revision: 0, builtins: ["poster"], workflows: [workflow] };

async function manage(base, path, data, { key, origin } = {}) {
  return read(await fetch(base + "/custom-mcp/" + path, { method: data === undefined ? "GET" : "POST",
    headers: { ...(data !== undefined && { "Content-Type": "application/json" }), ...(key && { Authorization: "Bearer " + key }),
      ...(origin && { Origin: origin }) },
    ...(data !== undefined && { body: JSON.stringify(data) }),
  }));
}
async function rpc(url, method, params, { token, origin, accept } = {}) {
  const response = await fetch(url, { method: "POST", headers: {
    "Content-Type": "application/json", Accept: accept ?? "application/json",
    ...(token && { Authorization: "Bearer " + token }), ...(origin && { Origin: origin }),
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const frames = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
    return { status: response.status, data: frames.at(-1), headers: response.headers };
  }
  return read(response);
}
const call = (url, name, args, opts) => rpc(url, "tools/call", { name, arguments: args }, opts);

async function dualHost(t) {
  const dir = await mkdtemp(join(tmpdir(), "custom-mcp-e2e-"));
  const graphs = join(dir, "graphs"), out = join(dir, "out");
  await mkdir(graphs);
  await writeFile(join(graphs, "poster.json"), JSON.stringify(WORKED_GRAPH));
  await writeFile(join(graphs, "other.json"), JSON.stringify(WORKED_GRAPH));
  const near = createFakeChain(), provider = nanoGptMock(), node = await nanoNode();
  const key = await throwawayNearKey();
  near.addAccount("merchant.testnet", 10n ** 25n, key.publicKey);
  near.addAccount("payer.testnet", 10n ** 25n);
  near.addFt(USDC_CONTRACTS.testnet, { "merchant.testnet": 0n, "payer.testnet": 10_000_000n });
  await near.listen();
  await provider.listen();
  const [nanoPort, nearPort] = await Promise.all([freePort(), freePort()]);
  const nanoBase = "http://127.0.0.1:" + nanoPort, nearBase = "http://127.0.0.1:" + nearPort;
  let child, stderr;
  async function stop() {
    if (child && child.exitCode === null && !child.signalCode) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  async function start() {
    stderr = "";
    child = spawn(process.execPath, ["bin/nanoodle-mcp.mjs", "--graphs", graphs, "--out", out, "--serve", "127.0.0.1:" + nanoPort,
      "--public-url", nanoBase, "--charge-usd", "0.05", "--near-serve", "127.0.0.1:" + nearPort, "--near-public-url", nearBase,
      "--near-merchant", "merchant.testnet", "--near-network", "testnet", "--near-rpc", near.url, "--near-usd", "3.64", "--xno-usd", "0.5",
      "--nano-rpc", node.url, "--no-local-work"], {
      env: { PATH: process.env.PATH, NANOGPT_API_KEY: "test", NANOGPT_BASE_URL: provider.url, NEAR_PRIVATE_KEY: key.secretKey,
        NANO_SEED: "0".repeat(64), NEAR_USDC: "1", NANOODLE_WRITER_LOCK_DIR: join(dir, "locks") },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    for (let attempt = 0; !stderr.includes("MCP over HTTP on"); attempt++) {
      assert.equal(child.exitCode, null, stderr);
      assert.ok(attempt < 500, stderr);
      await setTimeout(20);
    }
  }
  t.after(async () => {
    await stop();
    await Promise.all([near.close(), provider.close(), node.close()]);
    await rm(dir, { recursive: true, force: true });
  });
  await start();
  return { nanoBase, nearBase, out, graphs, provider, near, logs: () => stderr, restart: async () => { await stop(); await start(); } };
}

test("Custom MCP on both listeners saves, isolates, resumes and revokes private profiles with real checkout gates", { timeout: 35_000 }, async t => {
  const { nanoBase, nearBase, out, graphs, provider, near, logs, restart } = await dualHost(t);
  const key = owner(), token = client(), secondKey = owner(), secondToken = client();
  const routes = {};
  for (const base of [nanoBase, nearBase]) {
    const landing = await (await fetch(base)).text();
    assert.match(landing, /href="\/custom-mcp">Add a Custom MCP/);
    assert.match(landing, /mcp add --transport http/);
    const page = await fetch(base + "/custom-mcp");
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(await page.text(), /Choose the tools your agent can use/);
    assert.equal((await fetch(base + "/custom-mcp.js")).status, 200);
    assert.equal((await fetch(base + "/creators")).status, base === nearBase ? 200 : 404);
    const defaults = names(await rpc(base + "/mcp", "tools/list"));
    assert.ok(defaults.includes("poster") && defaults.includes("other") && defaults.includes("run_noodle"));
    assert.ok(!defaults.includes("my-poster"));

    const start = await manage(base, "profile");
    assert.equal(start.data.profile, null);
    assert.ok(!start.data.available.some(tool => tool.name === "run_noodle"));
    const created = await manage(base, "profile", config, { key });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const profile = created.data.profile;
    assert.equal(created.headers.get("set-cookie"), null);
    assert.match(profile.endpoint, /^\/custom-mcp\/cm_[a-f0-9]{32}\/mcp$/);
    assert.equal((await manage(base, "profile", config, { key })).status, 409);
    assert.equal((await manage(base, "profile", undefined, { key: owner() })).status, 401);
    assert.equal((await manage(base, "profile", undefined, { key: token })).status, 401);
    assert.deepEqual((await manage(base, "profile", undefined, { key })).data.profile, profile);
    const connected = await manage(base, "connection", { revision: profile.revision, token }, { key });
    assert.equal(connected.data.profile.connected, true);
    assert.equal((await manage(base, "connection", { revision: profile.revision, token }, { key })).status, 200);
    const url = base + profile.endpoint;
    routes[base] = { ...connected.data.profile, endpoint: url };
    assert.equal((await rpc(url, "initialize")).status, 401);
    assert.equal((await rpc(url, "initialize", {}, { token: key })).status, 401);
    assert.equal((await rpc(url, "initialize", {}, { token, origin: "https://different.invalid" })).status, 403);
    assert.equal((await rpc(url + "?token=discarded", "initialize", {}, { token })).status, 404);
    assert.equal((await rpc(url, "initialize", { protocolVersion: "2025-06-18" }, { token })).data.result.serverInfo.name, "nanoodle-custom-mcp");
    const tools = await rpc(url, "tools/list", {}, { token });
    assert.deepEqual(names(tools), ["poster", "my-poster"]);
    assert.equal(tools.headers.get("cache-control"), "no-store");
    assert.deepEqual(tools.data.result.tools[1].inputSchema.properties._pay_with.enum, base === nearBase ? ["near", "usdc"] : ["nano", "near", "usdc"]);
    assert.doesNotMatch(JSON.stringify(tools.data.result.tools[1]), /Write one vivid image prompt|"nodes"|"links"/);
    for (const hidden of ["other", "run_noodle", "custom_workflow", "My-Poster"]) {
      assert.equal((await call(url, hidden, input, { token })).data.error.code, -32602);
    }
    assert.equal((await call(url, "my-poster", { ...input, graph: WORKED_GRAPH }, { token })).data.error.code, -32602);
    assert.equal((await call(url, "my-poster", { Idea: ["wrong"] }, { token })).data.error.code, -32602);
    assert.equal((await call(url, "my-poster", { ...input, _payment_id: "" }, { token })).data.error.code, -32602);
  }

  const { endpoint: privateNear, revision, id } = routes[nearBase];
  const { endpoint: privateNano } = routes[nanoBase];
  assert.equal(routes[nanoBase].id, id);
  const second = await manage(nearBase, "profile", config, { key: secondKey });
  const otherEndpoint = nearBase + second.data.profile.endpoint;
  await manage(nearBase, "connection", { revision: second.data.profile.revision, token: secondToken }, { key: secondKey });
  assert.notEqual(second.data.profile.id, id);
  assert.equal((await manage(nearBase, "connection", { revision: 2, token: null }, { key: token })).status, 401);
  assert.equal((await rpc(privateNear, "tools/list", {}, { token: secondToken })).status, 401);
  assert.equal((await rpc(otherEndpoint, "tools/list", {}, { token })).status, 401);
  assert.deepEqual(names(await rpc(otherEndpoint, "tools/list", {}, { token: secondToken })), ["poster", "my-poster"]);
  assert.equal((await manage(nearBase, "profile", { ...config, revision, workflows: [{ ...workflow, name: "POSTER" }] }, { key })).status, 400);
  assert.equal((await manage(nearBase, "profile", { ...config, revision, workflows: [{ ...workflow, graph: { nodes: [
    { id: "1", type: "upload", fields: {} },
  ], links: [] } }] }, { key })).status, 400);
  assert.equal((await manage(nearBase, "profile", { ...config, revision }, { key, origin: "https://different.invalid" })).status, 403);
  assert.equal((await manage(nearBase, "profile", { revision, builtins: ["other"], workflows: [
    { name: "my-poster", description: "Renamed description", previousName: "my-poster" },
  ] }, { key })).status, 200);
  assert.equal(provider.runs(), 0);
  const nano = await call(privateNano, "my-poster", input, { token });
  assert.match(nano.data.result.structuredContent.x402.paymentId, /^pay_/);
  assert.equal(provider.runs(), 0);
  const resumeNano = await call(privateNano, "my-poster", { ...input, _payment_id: nano.data.result.structuredContent.x402.paymentId }, { token });
  assert.match(resumeNano.data.result.content[0].text, /hasn't arrived/);
  for (const asset of ["near", "usdc"]) {
    const result = await call(privateNear, "my-poster", { ...input, _pay_with: asset }, { token });
    const payment = result.data.result.structuredContent.payment;
    assert.match(payment.paymentId, /^nq_/);
    const paidInput = { ...input, _payment_id: payment.paymentId };
    const publicResume = await call(nearBase + "/mcp", "run_noodle", {
      graph: WORKED_GRAPH, inputs: input, _payment_id: payment.paymentId,
    });
    assert.match(publicResume.data.result.content[0].text, /different call/);
    const wrongOwner = await call(otherEndpoint, "my-poster", paidInput, { token: secondToken });
    assert.match(wrongOwner.data.result.content[0].text, /different call/);
    const current = (await manage(nearBase, "profile", undefined, { key })).data.profile;
    assert.equal((await manage(nearBase, "profile", { revision: current.revision, builtins: [], workflows: [] }, { key })).status, 409);
    assert.equal((await manage(nearBase, "delete", { revision: current.revision }, { key })).status, 409);
    const tx = asset === "near" ? near.transfer("payer.testnet", "merchant.testnet", BigInt(payment.amountYocto))
      : near.ftTransfer(USDC_CONTRACTS.testnet, "payer.testnet", "merchant.testnet", BigInt(payment.amountAtomic));
    const completed = await call(privateNear, "my-poster", { ...paidInput, _payment_tx: tx, _payment_sender: "payer.testnet" },
      { token, accept: "application/json, text/event-stream" });
    assert.equal(completed.headers.get("cache-control"), "no-store");
    assert.equal(completed.data.result.structuredContent.receipt.outcome, "succeeded");
    assert.equal(completed.data.result.structuredContent.receipt.refund.status, "sent");
    assert.equal((await fetch(nearBase + "/near/result/" + payment.paymentId)).status, 404);
    const publicStatus = await (await fetch(nearBase + "/near/status/" + payment.paymentId)).json();
    assert.equal(publicStatus.resultInClient, true);
    assert.equal(publicStatus.workflow, undefined);
    const checkout = await (await fetch(nearBase + "/pay/" + payment.paymentId)).text();
    assert.match(checkout, /Your workflow continues in your Custom MCP client/);
  }
  assert.equal(provider.runs(), 2);
  const actualFile = join(out, "custom-mcp-profiles", id + ".json");
  assert.equal((await stat(actualFile)).mode & 0o777, 0o600);
  const stored = await readFile(actualFile, "utf8");
  assert.ok(!stored.includes(key) && !stored.includes(token));
  const privateFields = [
    key, token, secondKey, secondToken, id, workflow.name, workflow.description, input.Idea,
    ...[key, token, secondKey, secondToken].map(secret => createHash("sha256").update(secret).digest("hex")),
    WORKED_GRAPH.nodes.find(node => node.type === "llm").fields.system,
  ];
  const checkoutFiles = ["gate-state.json", "near-state.json", "usage.jsonl", "near-usage.jsonl"];
  const checkout = await Promise.all(checkoutFiles.map(file => readFile(join(out, file), "utf8")));
  for (const [index, data] of [...checkout, logs()].entries()) {
    assert.ok(privateFields.every(value => !data.includes(value)), `Private profile material in ${checkoutFiles[index] ?? "service logs"}`);
  }
  const nanoQuotes = JSON.parse(checkout[0]).quotes;
  const nearQuotes = Object.values(JSON.parse(checkout[1]).quotes);
  assert.equal(nanoQuotes.length, 1);
  assert.equal(nearQuotes.length, 2);
  for (const quote of [...nanoQuotes, ...nearQuotes]) {
    assert.match(quote.paymentScope, /^[a-f0-9]{64}$/);
    assert.match(quote.argsHash, /^[a-f0-9]{32}$/);
  }
  await restart();
  for (const quote of nearQuotes) {
    assert.equal(quote.workflow, undefined);
    const publicStatus = await (await fetch(nearBase + "/near/status/" + quote.id)).json();
    assert.equal(publicStatus.resultInClient, true);
    assert.equal(publicStatus.workflow, undefined);
  }
  assert.deepEqual(names(await rpc(privateNear, "tools/list", {}, { token })), ["other", "my-poster"]);
  const latest = (await manage(nearBase, "profile", undefined, { key })).data.profile;
  const revoked = await manage(nearBase, "connection", { revision: latest.revision, token: null }, { key });
  assert.equal(revoked.data.profile.connected, false);
  assert.equal((await rpc(privateNear, "initialize", {}, { token })).status, 401);
  assert.equal((await rpc(privateNano, "initialize", {}, { token })).status, 200);
  const replacement = client();
  const rotated = await manage(nearBase, "connection", { revision: revoked.data.profile.revision, token: replacement }, { key });
  assert.equal(rotated.data.profile.connected, true);
  assert.equal((await rpc(privateNear, "tools/list", {}, { token: replacement })).status, 200);
  assert.equal((await rpc(privateNear, "tools/list", {}, { token })).status, 401);

  // Registry changes can leave older choices saved. A stale tool is never callable.
  await rm(join(graphs, "other.json"));
  await restart();
  assert.deepEqual(names(await rpc(privateNear, "tools/list", {}, { token: replacement })), ["my-poster"]);
  assert.equal((await call(privateNear, "other", input, { token: replacement })).data.error.code, -32602);
  const beforeDelete = (await manage(nearBase, "profile", undefined, { key })).data.profile;
  assert.deepEqual(beforeDelete.builtins, ["other"]);
  const deleted = await manage(nearBase, "delete", { revision: beforeDelete.revision }, { key });
  assert.equal(deleted.data.profile.revision, 0);
  assert.equal((await rpc(privateNear, "tools/list", {}, { token: replacement })).status, 401);
  assert.equal((await rpc(privateNano, "tools/list", {}, { token })).status, 200);
});

test("stale built-ins and retired subnano_comment aliases are refused before quotes or resumes on both listeners", { timeout: 15_000 }, async t => {
  const { nanoBase, nearBase, out, provider } = await dualHost(t);
  const retired = "subnano_comment", stale = "missing-poster";
  const key = owner(), token = client();
  const installed = [];
  for (const base of [nanoBase, nearBase]) {
    const standard = names(await rpc(base + "/mcp", "tools/list"));
    assert.ok(!standard.includes(retired));
    assert.ok(standard.includes("poster") && standard.includes("run_noodle"));
    const catalog = (await manage(base, "profile")).data.available.map(tool => tool.name);
    assert.deepEqual(catalog, standard.filter(name => !["run_noodle", "price_noodle"].includes(name)));

    assert.equal((await manage(base, "profile", { ...config, builtins: [retired] }, { key })).status, 400);
    const profile = (await manage(base, "profile", config, { key })).data.profile;
    const connection = await manage(base, "connection", { revision: profile.revision, token }, { key });
    assert.equal(connection.status, 200);
    installed.push({ base, profile: connection.data.profile, alias: base === nearBase ? "Subnano_Comment" : retired });
  }

  // Reopen a real profile with the entries an older registry could leave
  // behind. A retired alias must be blocked even if its graph still works.
  const file = join(out, "custom-mcp-profiles", installed[0].profile.id + ".json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  for (const { base, alias } of installed) {
    saved.hosts[base].builtins.push(retired, stale);
    saved.hosts[base].workflows.push({ ...workflow, name: alias });
  }
  await writeFile(file, JSON.stringify(saved));

  for (const { base, profile, alias } of installed) {
    const url = base + profile.endpoint;
    assert.deepEqual(names(await rpc(url, "tools/list", {}, { token })), ["poster", "my-poster"]);
    const rails = base === nearBase ? ["near", "usdc"] : ["nano", "near", "usdc"];
    for (const asset of rails) {
      const args = { ...input, _pay_with: asset };
      const paymentId = asset === "nano" ? "pay_AAAAAAAAAAAA" : "nq_AAAAAAAAAAAA";
      const publicCall = await call(base + "/mcp", retired, args);
      assert.ok(publicCall.data.error || publicCall.data.result?.isError);
      assert.ok(!publicCall.data.result?.structuredContent);
      for (const name of new Set([retired, stale, alias])) {
        for (const arguments_ of [args, { ...args, _payment_id: paymentId }]) {
          const rejected = await call(url, name, arguments_, { token });
          assert.deepEqual(rejected.data.error, { code: -32602, message: "This tool is unavailable in your Custom MCP profile." });
        }
      }
    }
    const clientConfig = { ...config, revision: profile.revision, workflows: [{ ...workflow, name: alias }] };
    assert.equal((await manage(base, "profile", clientConfig, { key })).status, 400);
    const rename = { ...clientConfig, builtins: ["poster", retired, stale], workflows: [
      { name: "recovered-workflow", description: workflow.description, previousName: alias },
    ] };
    assert.equal((await manage(base, "profile", rename, { key })).status, 200);
    assert.deepEqual(names(await rpc(url, "tools/list", {}, { token })), ["poster", "recovered-workflow"]);
  }

  for (const state of ["gate-state.json", "near-state.json"]) {
    const content = await readFile(join(out, state), "utf8").catch(error => {
      if (error.code !== "ENOENT") throw error;
      return "{}";
    });
    assert.deepEqual(Object.keys(JSON.parse(content).quotes ?? {}), [], state);
  }
  assert.equal(provider.runs(), 0);
});

test("stale workflows cannot squat tool names, duplicate each other, or brick the profile", { timeout: 35_000 }, async t => {
  const { nanoBase, nearBase, out } = await dualHost(t);
  const key = owner(), token = client();
  const installed = [];
  for (const base of [nanoBase, nearBase]) {
    const profile = (await manage(base, "profile", config, { key })).data.profile;
    const connection = await manage(base, "connection", { revision: profile.revision, token }, { key });
    assert.equal(connection.status, 200);
    installed.push({ base, profile: connection.data.profile });
  }

  // Reopen a real profile with stale workflow entries update() would never
  // accept today: one squatting an unselected built-in's name, a duplicate
  // pair differing only by case, and one whose inputs the current library
  // can no longer describe (an upload input is not Text or Choice).
  const file = join(out, "custom-mcp-profiles", installed[0].profile.id + ".json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  const poison = { name: "poison", description: "", graph: { nodes: [
    { id: "p1", type: "upload", fields: {} },
    { id: "p2", type: "llm", fields: { model: "z-ai/glm-5.3-flash", system: "x" } },
  ], links: [{ id: "pl1", from: { node: "p1", port: "image" }, to: { node: "p2", port: "prompt" } }] } };
  for (const { base } of installed) {
    const host = saved.hosts[base];
    host.workflows = [poison, ...host.workflows,
      { ...workflow, name: "other" }, { ...workflow, name: "dup" }, { ...workflow, name: "DUP" }];
  }
  await writeFile(file, JSON.stringify(saved));

  for (const { base, profile } of installed) {
    const url = base + profile.endpoint;
    assert.deepEqual(names(await rpc(url, "tools/list", {}, { token })), ["poster", "my-poster", "dup"]);
    for (const hidden of ["other", "DUP", "poison"]) {
      assert.deepEqual((await call(url, hidden, input, { token })).data.error,
        { code: -32602, message: "This tool is unavailable in your Custom MCP profile." });
    }
    // The poisoned entry must not brick token rotation for the whole profile.
    const current = (await manage(base, "profile", undefined, { key })).data.profile;
    const rotated = client();
    assert.equal((await manage(base, "connection", { revision: current.revision, token: rotated }, { key })).status, 200);
    assert.deepEqual(names(await rpc(url, "tools/list", {}, { token: rotated })), ["poster", "my-poster", "dup"]);
    assert.equal((await rpc(url, "tools/list", {}, { token })).status, 401);
  }
});

test("payments stay bound to their profile across hosts, revocation, rotation and concurrent resumes", { timeout: 60_000 }, async t => {
  const { nanoBase, nearBase, provider, near } = await dualHost(t);
  const keyA = owner(), tokenA = client(), keyB = owner(), tokenB = client();
  const setup = async (base, key, token) => {
    const created = await manage(base, "profile", config, { key });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const connected = await manage(base, "connection", { revision: created.data.profile.revision, token }, { key });
    assert.equal(connected.status, 200, JSON.stringify(connected.data));
    return connected.data.profile;
  };
  const nanoA = await setup(nanoBase, keyA, tokenA), nanoB = await setup(nanoBase, keyB, tokenB);
  const nearA = await setup(nearBase, keyA, tokenA), nearB = await setup(nearBase, keyB, tokenB);
  const urlNanoA = nanoBase + nanoA.endpoint, urlNanoB = nanoBase + nanoB.endpoint;
  const urlNearA = nearBase + nearA.endpoint, urlNearB = nearBase + nearB.endpoint;

  // Nano rail: the checkout surface carries no private profile material, and
  // another profile cannot resume this profile's quote.
  const nanoQuote = await call(urlNanoA, "my-poster", input, { token: tokenA });
  const nanoPaymentId = nanoQuote.data.result.structuredContent.x402.paymentId;
  assert.match(nanoPaymentId, /^pay_/);
  const payPage = await (await fetch(nanoBase + "/pay/" + nanoPaymentId)).text();
  const status = await (await fetch(nanoBase + "/x402/status/" + nanoPaymentId)).text();
  for (const leak of ["my-poster", "Make a poster privately", "lighthouse", "Write one vivid"]) {
    assert.ok(!payPage.includes(leak), "Nano pay page leaks " + leak);
    assert.ok(!status.includes(leak), "Nano status leaks " + leak);
  }
  const crossNano = await call(urlNanoB, "my-poster", { ...input, _payment_id: nanoPaymentId }, { token: tokenB });
  assert.match(crossNano.data.result.content[0].text, /different call/);
  assert.equal(provider.runs(), 0);

  // An open Nano quote blocks removing tools or deleting the profile on its
  // own host, while an additive save still goes through.
  const openProfile = (await manage(nanoBase, "profile", undefined, { key: keyA })).data.profile;
  assert.equal((await manage(nanoBase, "profile", { revision: openProfile.revision, builtins: [], workflows: [] }, { key: keyA })).status, 409);
  assert.equal((await manage(nanoBase, "delete", { revision: openProfile.revision }, { key: keyA })).status, 409);
  assert.equal((await manage(nanoBase, "profile", { revision: openProfile.revision, builtins: ["poster", "other"], workflows: [workflow] }, { key: keyA })).status, 200);

  // NEAR rail: a paid quote cannot be consumed by another profile; revoking
  // the client token blocks resume, and a replacement token on the same
  // profile resumes it exactly once.
  const nearQuote = await call(urlNearA, "my-poster", { ...input, _pay_with: "near" }, { token: tokenA });
  const payment = nearQuote.data.result.structuredContent.payment;
  const tx = near.transfer("payer.testnet", "merchant.testnet", BigInt(payment.amountYocto));
  const paidArgs = { ...input, _payment_id: payment.paymentId, _payment_tx: tx, _payment_sender: "payer.testnet" };
  const crossNear = await call(urlNearB, "my-poster", paidArgs, { token: tokenB });
  assert.match(crossNear.data.result.content[0].text, /different call/);
  assert.equal(provider.runs(), 0);
  const beforeRevoke = (await manage(nearBase, "profile", undefined, { key: keyA })).data.profile;
  assert.equal((await manage(nearBase, "connection", { revision: beforeRevoke.revision, token: null }, { key: keyA })).status, 200);
  assert.equal((await call(urlNearA, "my-poster", paidArgs, { token: tokenA })).status, 401);
  assert.equal(provider.runs(), 0);
  const beforeRotate = (await manage(nearBase, "profile", undefined, { key: keyA })).data.profile;
  const tokenA2 = client();
  assert.equal((await manage(nearBase, "connection", { revision: beforeRotate.revision, token: tokenA2 }, { key: keyA })).status, 200);
  const completed = await call(urlNearA, "my-poster", paidArgs, { token: tokenA2 });
  assert.equal(completed.data.result.structuredContent.receipt.outcome, "succeeded");
  assert.equal(provider.runs(), 1);
  const replay = await call(urlNearA, "my-poster", paidArgs, { token: tokenA2 });
  assert.equal(replay.data.result.structuredContent.receipt.outcome, "succeeded");
  assert.equal(provider.runs(), 1);

  // Two concurrent resumes of a second paid quote run the workflow once.
  const secondQuote = await call(urlNearA, "my-poster", { ...input, _pay_with: "near" }, { token: tokenA2 });
  const secondPayment = secondQuote.data.result.structuredContent.payment;
  const secondTx = near.transfer("payer.testnet", "merchant.testnet", BigInt(secondPayment.amountYocto));
  const secondArgs = { ...input, _payment_id: secondPayment.paymentId, _payment_tx: secondTx, _payment_sender: "payer.testnet" };
  const [first, second] = await Promise.all([
    call(urlNearA, "my-poster", secondArgs, { token: tokenA2 }),
    call(urlNearA, "my-poster", secondArgs, { token: tokenA2 }),
  ]);
  assert.equal(first.data.result.structuredContent.receipt.outcome, "succeeded");
  assert.equal(second.data.result.structuredContent.receipt.outcome, "succeeded");
  assert.equal(provider.runs(), 2);
});
