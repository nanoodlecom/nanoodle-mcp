import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { on, once } from "node:events";
import fs, { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costProviderKey } from "../src/cost-sidecar.mjs";
import { loadTools, renderCost } from "../src/tools.mjs";

const result = costUsd => ({ costUsd, outputs: {}, nodes: {} });
const call = (registry, name = "chat") => registry.callTool({ name, arguments: {} });
const graph = text => JSON.stringify({ v: 1, nodes: [{ id: "n", type: "text", fields: { text } }], links: [] });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-cost-sidecar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outDir = join(dir, "out");
  await mkdir(outDir);
  await Promise.all(["chat", "other"].map(name => writeFile(join(dir, `${name}.json`), graph(name))));
  const warnings = [];
  const load = () => loadTools({ dirs: [dir], outDir, log: message => warnings.push(message) });
  const registry = await load();
  const keys = Object.fromEntries(registry.tools.map(tool => [tool.name, tool.costKey]));
  return { dir, load, registry, keys, outDir, warnings, costsPath: join(outDir, "costs.json") };
}

function syncFsMocks(t) {
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("cost provider identity normalizes equivalent URLs and retains API paths", () => {
  const one = costProviderKey("HTTPS://PROVIDER.EXAMPLE:443/api/../tenant-a///");
  assert.equal(one, costProviderKey("https://provider.example/tenant-a"));
  assert.notEqual(one, costProviderKey("http://provider.example/tenant-a"));
  assert.notEqual(one, costProviderKey("https://provider.example:444/tenant-a"));
  assert.notEqual(one, costProviderKey("https://provider.example/tenant-b"));
});

test("aliases of one executable share live and durable observations", async t => {
  const { dir, load, costsPath } = await fixture(t);
  await writeFile(join(dir, "alias.json"), graph("chat"));
  const registry = await load();
  const chat = registry.tools.find(tool => tool.name === "chat");
  t.mock.method(chat.wf, "run", async () => result(0.90));
  let changes = 0;
  registry.onToolsChanged = () => { changes++; };

  await call(registry);
  assert.equal(registry.costs.alias, registry.costs.chat);
  assert.equal(registry.costs.alias.usd, 0.90);
  assert.match(registry.tools.find(tool => tool.name === "alias").description, /last run \$0\.90/);
  assert.equal(changes, 1);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(costsPath, "utf8"))), [chat.costKey]);
  assert.equal((await load()).costs.alias.usd, 0.90);
});

test("nested tool-name collisions keep live cost histories separate", async t => {
  const { dir, outDir } = await fixture(t);
  const alternate = join(dir, "alternate");
  await mkdir(alternate);
  await Promise.all([
    writeFile(join(dir, "chat-2.json"), graph("already uses chat-2")),
    writeFile(join(alternate, "chat.json"), graph("another chat")),
  ]);
  const registry = await loadTools({ dirs: [dir, alternate], outDir });
  const chats = registry.tools.filter(tool => /^chat(?:-\d+)?$/.test(tool.name));
  assert.deepEqual(chats.map(tool => tool.name).sort(), ["chat", "chat-2", "chat-3"]);
  for (const [index, tool] of chats.entries()) {
    const cost = (index + 1) / 10;
    t.mock.method(tool.wf, "run", async () => result(cost));
    await call(registry, tool.name);
    assert.equal(registry.costs[tool.name].usd, cost);
  }
  assert.equal(new Set(chats.map(tool => registry.costs[tool.name].usd)).size, 3);
});

test("a delayed cost write cannot overwrite newer observations after reopening", { timeout: 5_000 }, async t => {
  const { registry, load, outDir, costsPath } = await fixture(t);
  const [chat, other] = registry.tools;
  const secondRan = Promise.withResolvers(), otherRan = Promise.withResolvers();
  let chatRuns = 0;
  t.mock.method(chat.wf, "run", async () => {
    if (chatRuns++ === 0) return result(0.01);
    secondRan.resolve();
    return result(0.90);
  });
  t.mock.method(other.wf, "run", async () => { otherRan.resolve(); return result(0.40); });

  const firstWriting = Promise.withResolvers(), releaseFirst = Promise.withResolvers();
  const originalMkdir = fs.mkdir, originalWrite = fs.writeFile;
  // The out dir exists. Make entry to each write deterministic while retaining real writes and renames.
  t.mock.method(fs, "mkdir", async (path, options) => {
    if (path !== outDir) return originalMkdir(path, options);
  });
  let writes = 0;
  t.mock.method(fs, "writeFile", async (path, data, options) => {
    if (String(path).startsWith(`${costsPath}.`) && ++writes === 1) {
      firstWriting.resolve(data);
      await releaseFirst.promise;
    }
    return originalWrite(path, data, options);
  });
  syncFsMocks(t);

  const notifications = [];
  registry.onToolsChanged = () => notifications.push([chat, other].map(tool => ({
    description: tool.description, cost: renderCost(registry.costs[tool.name]),
  })));
  const runs = [call(registry)];
  try {
    assert.equal(JSON.parse(await firstWriting.promise)[chat.costKey].usd, 0.01);
    runs.push(call(registry), call(registry, "other"));
    await Promise.all([secondRan.promise, otherRan.promise]);
    await new Promise(setImmediate);
    // If writes overlap, let both newer snapshots land before the old one.
    if (writes > 1) await Promise.all(runs.slice(1));
  } finally {
    releaseFirst.resolve();
    await Promise.all(runs);
  }

  const reopened = await load();
  assert.equal(reopened.costs.chat.usd, 0.90);
  assert.equal(reopened.costs.other.usd, 0.40);
  assert.equal(writes, 2, "observations made during the first write share a queued batch");
  assert.match(chat.description, /last run \$0\.90/);
  assert.equal(notifications.length, 3);
  for (const snapshot of notifications) {
    for (const { description, cost } of snapshot) assert.ok(description.includes(cost), `${cost} missing from ${description}`);
  }
  t.mock.method(reopened.tools[0].wf, "run", async () => result(0.02));
  await call(reopened);
  assert.deepEqual(Object.fromEntries(Object.entries((await load()).costs).map(([name, record]) => [name, [record.usd, record.hiUsd]])), {
    chat: [0.02, 0.90], other: [0.40, undefined],
  });
});

test("a failed cost rename leaves the observation in memory and the next write repairs the sidecar", async t => {
  const { registry, load, outDir, costsPath, warnings } = await fixture(t);
  assert.deepEqual(await readdir(outDir), [], "loading the registry does not create the lock file");
  const realRename = fs.rename;
  let failed = false;
  t.mock.method(fs, "rename", async (src, dest) => {
    if (dest === costsPath && !failed) { failed = true; throw Error("fixture disk write failure"); }
    return realRename(src, dest);
  });
  syncFsMocks(t);
  let runs = 0;
  t.mock.method(registry.tools[0].wf, "run", async () => result(runs++ === 0 ? 0.90 : 0.01));

  await call(registry);
  assert.equal(registry.costs.chat.usd, 0.90);
  assert.match(registry.tools[0].description, /last run \$0\.90/);
  assert.deepEqual(await readdir(outDir), ["costs.json.lock"]);
  assert.ok(warnings.some(line => line.includes("fixture disk write failure")));
  await call(registry);
  const reopened = await load();
  assert.equal(reopened.costs.chat.usd, 0.01);
  assert.equal(reopened.costs.chat.hiUsd, 0.90);
  assert.deepEqual(await readdir(outDir), ["costs.json", "costs.json.lock"]);
});

test("refreshes preserve a pending cost while a write fails and an older read finishes", { timeout: 5_000 }, async t => {
  const { registry, load, keys, costsPath } = await fixture(t);
  await writeFile(costsPath, JSON.stringify({ [keys.chat]: { usd: 0.01, at: "2026-07-20T00:00:00Z" } }));
  const reading = Promise.withResolvers(), resumeRead = Promise.withResolvers();
  const writing = Promise.withResolvers(), failWrite = Promise.withResolvers();
  const originalRead = fs.readFile, originalRename = fs.rename;
  let delayRead = true, delayWrite = true;
  t.mock.method(fs, "readFile", async (file, options) => {
    const text = await originalRead(file, options);
    if (typeof file?.fd === "number" && delayRead) {
      delayRead = false;
      reading.resolve();
      await resumeRead.promise;
    }
    return text;
  });
  t.mock.method(fs, "rename", async (src, dest) => {
    if (dest === costsPath && delayWrite) {
      delayWrite = false;
      writing.resolve();
      await failWrite.promise;
      throw Error("fixture disk write failure");
    }
    return originalRename(src, dest);
  });
  syncFsMocks(t);
  let runs = 0;
  t.mock.method(registry.tools[0].wf, "run", async () => result(runs++ === 0 ? 0.90 : 0.03));

  const staleRead = registry.refreshCosts();
  let run;
  try {
    await reading.promise;
    run = call(registry);
    await writing.promise;
    await registry.refreshCosts();
    assert.equal(registry.costs.chat.usd, 0.90);
  } finally {
    failWrite.resolve();
    resumeRead.resolve();
    await Promise.all([staleRead, run]);
  }

  assert.match(registry.tools[0].description, /last run \$0\.90/);
  assert.equal((await load()).costs.chat.usd, 0.01);
  await call(registry);
  const reopened = await load();
  assert.equal(reopened.costs.chat.usd, 0.03);
  assert.equal(reopened.costs.chat.hiUsd, 0.90);
});

async function startWriter(t, { dir, outDir }, mode) {
  const helper = new URL("./fixtures/cost-writer.mjs", import.meta.url);
  const child = fork(helper, [dir, outDir, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] });
  const messages = on(child, "message", { close: ["exit"] }), exit = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exit; });
  async function receive(event) {
    const message = (await messages.next()).value?.[0];
    assert.equal(message?.event, event, `expected ${event}, got ${JSON.stringify(message)}\n${stderr}`);
    return message;
  }
  await receive("ready");
  return { child, exit, receive, send: message => child.send(message) };
}

test("processes merge distinct tools and keep the newest same-tool observation", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await writeFile(f.costsPath, JSON.stringify({ [f.keys.chat]: { usd: 0.50, at: "2026-07-20T00:00:00Z" } }));
  const [old, recent] = await Promise.all([startWriter(t, f, "before-lock"), startWriter(t, f, "normal")]);
  old.send({ name: "chat", usd: 0.90 });
  await old.receive("paused");
  recent.send({ name: "chat", usd: 0.01, exact: false });
  const recentCosts = (await recent.receive("done")).costs;
  assert.equal(recentCosts.chat.hiUsd, 0.50);
  assert.equal(recentCosts.chat.quoteHiUsd, 0.50);
  recent.send({ name: "other", usd: 0.40 });
  await recent.receive("done");
  old.send({ release: true });
  const merged = await old.receive("done");
  assert.equal(merged.costs.chat.usd, 0.01);
  assert.equal(merged.costs.chat.exact, false);
  assert.equal(merged.costs.chat.hiUsd, 0.90);
  assert.equal(merged.costs.chat.quoteHiUsd, 0.90);
  assert.equal(merged.costs.other.usd, 0.40);
  assert.match(merged.description, /last run \$0\.01\+/);
  assert.deepEqual(JSON.parse(await readFile(f.costsPath, "utf8")), {
    [f.keys.chat]: merged.costs.chat, [f.keys.other]: merged.costs.other,
  });
  assert.equal((await f.load()).costs.chat.quoteHiUsd, 0.90);
});

test("contending writers with the same tool name preserve two workflow histories", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  const alternate = join(f.dir, "alternate");
  await mkdir(alternate);
  await writeFile(join(alternate, "chat.json"), graph("different workflow"));
  const [first, second] = await Promise.all([
    startWriter(t, f, "before-rename"),
    startWriter(t, { dir: alternate, outDir: f.outDir }, "report-busy"),
  ]);
  first.send({ name: "chat", usd: 0.90 });
  await first.receive("paused");
  second.send({ name: "chat", usd: 0.12, exact: false });
  await second.receive("busy");
  first.send({ release: true });
  assert.equal((await first.receive("done")).costs.chat.usd, 0.90);
  const changed = (await second.receive("done")).costs.chat;
  assert.equal(changed.usd, 0.12);
  assert.equal(changed.hiUsd, undefined);
  assert.equal((await f.load()).costs.chat.usd, 0.90);
  const reopened = await loadTools({ dirs: [alternate], outDir: f.outDir });
  assert.equal(reopened.costs.chat.usd, 0.12);
  assert.equal(reopened.costs.chat.quoteHiUsd, undefined);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(f.costsPath, "utf8"))).sort(),
    [f.keys.chat, reopened.tools[0].costKey].sort());
});

test("a competing writer recovers when the first process dies before rename", { timeout: 8_000 }, async t => {
  const f = await fixture(t);
  await writeFile(f.costsPath, JSON.stringify({ [f.keys.chat]: { usd: 0.25, at: "2026-07-20T00:00:00Z" } }));
  const [old, next] = await Promise.all([startWriter(t, f, "before-rename"), startWriter(t, f, "report-busy")]);
  old.send({ name: "chat", usd: 0.80 });
  await old.receive("paused");
  assert.equal(JSON.parse(await readFile(f.costsPath, "utf8"))[f.keys.chat].usd, 0.25);
  assert.equal(JSON.parse(await readFile(`${f.costsPath}.tmp`, "utf8"))[f.keys.chat].usd, 0.80);
  next.send({ name: "other", usd: 0.40 });
  await next.receive("busy");
  old.child.kill("SIGKILL");
  await old.exit;
  await next.receive("done");
  const reopened = await f.load();
  assert.equal(reopened.costs.chat.usd, 0.25);
  assert.equal(reopened.costs.other.usd, 0.40);
  assert.deepEqual(await readdir(f.outDir), ["costs.json", "costs.json.lock"]);
});
