/**
 * Review holds on the hosted sfw_check / paid-decision path.
 * No live NanoGPT calls. URL tests inject DNS and the socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { NanoClient } from "nanoodle";
import { looksLikeResult } from "../node_modules/nanoodle/src/x402.mjs";
import { createChargeGate } from "../src/gate.mjs";
import { loadTools } from "../src/tools.mjs";
import {
  MEDIA_MAX_REDIRECTS, finishResult, settledCharge, meteredWithinQuote, isBlockedIp, fetchPublicBytes,
  fitStillImage, imageDimensions, runProc, sampleVideoFrames, mediaProcs, videoContainer,
} from "../src/subnano.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "nanoodle-mcp.mjs");

const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const PAYER = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";

const TINY = JSON.stringify({
  v: 1,
  nodes: [
    { id: "n1", type: "text", x: 0, y: 0, fields: { text: "hi" } },
    { id: "n2", type: "llm", x: 0, y: 0, fields: { model: "m" } },
  ],
  links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
});

const PNG_1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function loadSfw({ hosted = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "subnano-hold-"));
  await writeFile(join(dir, "hello.json"), TINY);
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", outDir: join(dir, "out"), log: () => {}, hosted });
  return { dir, registry };
}

test("isBlockedIp rejects private, loopback, link-local, CGNAT, multicast, ULA, and IPv4-mapped private addresses", () => {
  const blocked = [
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "127.255.255.255",
    "169.254.169.254", "169.254.1.1",
    "100.64.0.0", "100.127.255.255",
    "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "224.0.0.1", "239.255.255.255", "255.255.255.255",
    "::1", "::", "fe80::1", "febf::1", "fec0::1", "feff::1", "fc00::1", "fd00::1", "fd12:3456::abcd", "ff02::1",
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:192.168.0.8",
    "::ffff:7f00:1", "::ffff:a00:1", "::ffff:169.254.169.254",
    "100::1", "2001::1", "2001:db8::1", "3fff::1",
    "64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "2002:a00:1::", "2002:7f00:1::",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "240.0.0.1",
  ];
  const allowed = [
    "1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1",
    "172.15.5.5", "172.32.0.1", "192.169.1.1", "11.0.0.1",
    "2001:4860:4860::8888", "::ffff:1.1.1.1", "::ffff:8.8.8.8",
    "64:ff9b::1.1.1.1", "64:ff9b::808:808", "2002:101:101::", "2002:808:808::1",
  ];
  for (const ip of blocked) assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of allowed) assert.equal(isBlockedIp(ip), false, ip);
});

test("hosted sfw_check never reads a local path, and URL fetches pin the validated address on every hop", async () => {
  const { dir, registry } = await loadSfw({ hosted: true });
  const existing = join(dir, "secret.jpg");
  await writeFile(existing, PNG_1);
  const missing = join(dir, "missing.jpg");
  const hostedMsg = /A hosted server does not read local files/;
  try {
    const sfw = registry.tools.find((t) => t.name === "sfw_check");
    assert.match(sfw.inputSchema.properties.image.description, /does not read local files/);
    assert.match(sfw.inputSchema.properties.image.description, /Does not use ffmpeg/);
    assert.doesNotMatch(sfw.inputSchema.properties.image.description, /file path/);
    assert.match(sfw.inputSchema.properties.video.description, /does not read local files/);
    assert.match(sfw.description, /a still image does not/);

    await assert.rejects(registry.prepareCall({ name: "sfw_check", arguments: { image: existing } }), hostedMsg);
    await assert.rejects(registry.prepareCall({ name: "sfw_check", arguments: { video: missing } }), hostedMsg);
    await assert.rejects(registry.prepareCall({ name: "sfw_check", arguments: { image: "http://127.0.0.1/a.jpg" } }), /not a public address/);
    await assert.rejects(registry.prepareCall({ name: "sfw_check", arguments: { image: "http://169.254.169.254/latest" } }), /not a public address/);
    await assert.rejects(registry.prepareCall({ name: "sfw_check", arguments: { image: "http://[::1]/a.jpg" } }), /not a public address/);
    await assert.rejects(registry.prepareCall({ name: "sfw_check", arguments: { image: "http://[::ffff:10.0.0.1]/a.jpg" } }), /not a public address/);
    await assert.rejects(registry.prepareCall({ name: "sfw_check", arguments: { image: "https://user:pass@example.com/a.jpg" } }), /credentials/);
    await registry.prepareCall({ name: "sfw_check", arguments: { image: "https://example.com/a.jpg" } });
    assert.throws(() => registry.quoteDeposit("sfw_check", { image: existing }), hostedMsg);

    const orig = mediaProcs.spawn;
    mediaProcs.spawn = () => { throw new Error("spawned"); };
    try {
      await assert.rejects(sampleVideoFrames(existing, 1, { hosted: true }), /does not read local files/);
    } finally {
      mediaProcs.spawn = orig;
    }

    const seen = [];
    const lookup = async (host) => {
      if (host === "ok.example") return [{ address: "1.2.3.4" }, { address: "8.8.4.4" }];
      if (host === "bad.example") return [{ address: "169.254.169.254" }];
      if (host === "split.example") return [{ address: "1.1.1.1" }, { address: "10.0.0.1" }];
      if (host === "mapped.example") return [{ address: "::ffff:192.168.0.9" }];
      if (host === "ula.example") return [{ address: "fd00::10" }];
      throw new Error("unmapped " + host);
    };
    const request = (url, ip) => {
      seen.push({ host: url.hostname, ip });
      if (seen.length === 1) {
        return { status: 302, headers: { location: "http://bad.example/secret" }, stream: Readable.from([]) };
      }
      return { status: 200, headers: {}, stream: Readable.from([Buffer.from("nope")]) };
    };
    await assert.rejects(
      fetchPublicBytes("http://ok.example/v.mp4", { lookup, request, timeoutMs: 1000 }),
      /refusing bad\.example: address is not public/,
    );
    assert.deepEqual(seen, [{ host: "ok.example", ip: "1.2.3.4" }], "the socket is pinned to the validated address; the private redirect is not dialed");

    seen.length = 0;
    await assert.rejects(fetchPublicBytes("http://split.example/v", { lookup, request, timeoutMs: 1000 }), /not public/);
    await assert.rejects(fetchPublicBytes("http://mapped.example/v", { lookup, request, timeoutMs: 1000 }), /not public/);
    await assert.rejects(fetchPublicBytes("http://ula.example/v", { lookup, request, timeoutMs: 1000 }), /not public/);
    await assert.rejects(fetchPublicBytes("http://127.0.0.1/v", { lookup, request, timeoutMs: 1000 }), /not public/);
    assert.equal(seen.length, 0, "a blocked address is never connected");

    let hops = 0;
    await assert.rejects(fetchPublicBytes("http://ok.example/start", {
      lookup,
      timeoutMs: 1000,
      request: (url, ip) => {
        hops++;
        assert.equal(ip, "1.2.3.4");
        assert.equal(url.hostname, "ok.example");
        return { status: 302, headers: { location: "http://ok.example/next" + hops }, stream: Readable.from([]) };
      },
    }), /too many redirects/);
    assert.equal(hops, MEDIA_MAX_REDIRECTS + 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("video download aborts past the byte cap and on timeout, and ffprobe/ffmpeg are killed when they expire", async () => {
  let pulls = 0;
  const stream = Readable.from((async function* () {
    pulls++;
    yield Buffer.alloc(800);
    pulls++;
    yield Buffer.alloc(800);
    pulls++;
    yield Buffer.alloc(800);
  })());
  let destroyed = false;
  const origDestroy = stream.destroy.bind(stream);
  stream.destroy = (...args) => { destroyed = true; return origDestroy(...args); };
  await assert.rejects(fetchPublicBytes("http://ok.example/big", {
    byteCap: 1000,
    timeoutMs: 1000,
    lookup: async () => [{ address: "1.2.3.4" }],
    request: () => ({ status: 200, headers: {}, stream }),
  }), /over 4 MB/);
  assert.equal(destroyed, true);
  assert.ok(pulls < 3, "the rest of the body is not downloaded, pulls=" + pulls);

  let headerPulls = 0;
  const unread = new Readable({ read() { headerPulls++; this.push(Buffer.alloc(64)); } });
  await assert.rejects(fetchPublicBytes("http://ok.example/len", {
    byteCap: 100,
    timeoutMs: 1000,
    lookup: async () => [{ address: "1.1.1.1" }],
    request: () => ({ status: 200, headers: { "content-length": "5000" }, stream: unread }),
  }), /over 4 MB/);
  assert.equal(headerPulls, 0, "content-length over the cap is refused before the body is read");

  await assert.rejects(fetchPublicBytes("http://ok.example/slow", {
    timeoutMs: 40,
    lookup: async () => [{ address: "1.1.1.1" }],
    request: () => new Promise(() => {}),
  }), /timed out/);

  const dir = await mkdtemp(join(tmpdir(), "sfw-proc-"));
    const marker = "sfw-hold-sleep-" + process.pid + "-" + Date.now();
  const script = `#!/usr/bin/env node\nprocess.title = ${JSON.stringify(marker)};\nsetInterval(() => {}, 1000);\n`;
  try {
    for (const name of ["ffprobe", "ffmpeg"]) {
      const bin = join(dir, name);
      await writeFile(bin, script);
      await chmod(bin, 0o755);
    }
    const saved = process.env.PATH;
    process.env.PATH = dir + ":" + saved;
    try {
      for (const name of ["ffprobe", "ffmpeg"]) {
        const t0 = Date.now();
        await assert.rejects(runProc(name, ["-hide_banner"], { timeoutMs: 200 }), new RegExp(`${name} timed out`));
        assert.ok(Date.now() - t0 < 5000, name + " was not left to run");
      }
    } finally {
      process.env.PATH = saved;
    }
    await new Promise((r) => setTimeout(r, 100));
    const ps = execFileSync("ps", ["-eo", "args,comm"], { encoding: "utf8" });
    assert.equal(ps.includes(marker), false, "the timed-out process is still running:\n" + ps);
    assert.equal(ps.includes(join(dir, "ffprobe")), false);
    assert.equal(ps.includes(join(dir, "ffmpeg")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sampleVideoFrames reads a stdio local file and does not follow it in hosted mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sfw-clip-"));
  const file = join(dir, "tiny.mp4");
  try {
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.4",
      "-c:v", "mpeg4", file,
    ], { stdio: "ignore" });
    const frames = await sampleVideoFrames(file, 2, { timeoutMs: 15000 });
    assert.equal(frames.length, 2);
    assert.match(frames[0], /^data:image\/jpeg;base64,/);
    const dims = imageDimensions(Buffer.from(frames[0].split(",")[1], "base64"));
    assert.ok(dims.w <= 512 && dims.h <= 512);
    await assert.rejects(sampleVideoFrames(file, 1, { hosted: true, timeoutMs: 1000 }), /does not read local files/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a paid decision with answers and usage is success and is not resent", async () => {
  assert.equal(looksLikeResult({ status: "paid", paymentId: "pay1" }), false);
  assert.equal(looksLikeResult({ choices: [{ message: { content: "hi" } }] }), true);
  assert.equal(looksLikeResult({ answers: { answer: { type: "noul", noul: 0.9 } } }), false);
  const paid = {
    answers: { answer: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 12, output_tokens: 0, cost: 0.000002 },
  };
  assert.equal(looksLikeResult(paid), true);

  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    const u = String(url);
    const json = (status, body) => new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
    if (u.endsWith("/api/v1/decisions")) {
      if (init.headers && init.headers["x-x402-payment-id"]) return json(402, { error: "payment already used" });
      return json(402, {
        payment: {
          paymentId: "paydec",
          accepted: [{
            scheme: "nano", payTo: "nano_1stub", maxAmountRequired: "1000", maxAmountRequiredUSD: 0.0001,
            completeUrl: "https://nano-gpt.com/api/x402/complete/paydec",
          }],
        },
      });
    }
    if (u.endsWith("/api/x402/complete/paydec")) return json(200, paid);
    return json(500, { error: "unexpected " + u });
  };
  const client = new NanoClient({
    payment: async () => {},
    baseUrl: "https://nano-gpt.com",
    fetch,
    pollIntervals: { x402: 1 },
  });
  const got = await client.decide({ model: "perplexity/pplx-decider-v1.2", questions: { answer: { type: "noul", instructions: "x" } } });
  assert.equal(got.answers.answer.noul, 0.9);
  assert.equal(got.usage.cost, 0.000002);
  assert.equal(calls.filter((c) => c.url.endsWith("/api/v1/decisions")).length, 1);
  assert.equal(calls.some((c) => c.headers["x-x402-payment-id"]), false);
});

test("finishResult keeps the real provider cost exact and caps the billed amount at the deposit", () => {
  const over = finishResult({ comment: "x" }, [{ usd: 5, exact: true }], 0.01);
  assert.equal(over.providerUsd, 5);
  assert.equal(over.providerExact, true);
  assert.equal(over.costExact, false);
  assert.equal(over.billedUsd, 0.01);
  assert.equal(over.billedUsd, settledCharge(5, 0.01));
  assert.ok(over.costUsd < over.providerUsd);
  assert.equal(settledCharge(over.costUsd, 0.01), settledCharge(over.providerUsd, 0.01));
  assert.match(over.content[1].text, /cost: \$5\.0000/);
  assert.match(over.content[1].text, /billed \$0\.0100 \(capped at the deposit\)/);
  assert.doesNotMatch(over.content[1].text, /lower bound/);

  const under = finishResult({ comment: "x" }, [{ usd: 0.02 }, { usd: 0.01 }], 1);
  assert.equal(under.providerUsd, 0.03);
  assert.equal(under.providerExact, true);
  assert.equal(under.costExact, true);
  assert.equal(under.costUsd, 0.03);
  assert.equal(under.billedUsd, settledCharge(0.03, 1));
  assert.doesNotMatch(under.content[1].text, /capped at the deposit/);

  const partial = finishResult({ comment: "x" }, [{ usd: 0.2 }, { exact: false }], 1);
  assert.equal(partial.providerUsd, 0.2);
  assert.equal(partial.providerExact, false);
  assert.equal(partial.costExact, false);
  assert.match(partial.content[1].text, /lower bound/);
});

test("a clamped provider cost is billed at the deposit and the receipt does not call the clamp exact", async () => {
  const deposit = 0.05;
  const providerUsd = 5;
  const costUsd = meteredWithinQuote(providerUsd, deposit);
  const billedUsd = settledCharge(providerUsd, deposit);
  const registry = {
    tools: [{ name: "poster", description: "Make a poster. Runs on NanoGPT — every call spends real credit from your API key's balance.", inputSchema: { type: "object", properties: {} } }],
    listTools: () => [{ name: "poster", description: registry.tools[0].description, inputSchema: { type: "object", properties: {} } }],
    prepareCall: async () => ({}),
    callTool: async () => ({
      content: [{ type: "text", text: "ran" }],
      costUsd, costExact: false, providerUsd, providerExact: true, billedUsd, textOutput: true,
    }),
  };
  const state = { receivable: {}, transfers: [] };
  const gate = createChargeGate({
    address: GATE_ADDR,
    ops: {
      rpc: async (body) => body.action === "receivable" ? { blocks: state.receivable } : { history: [] },
      transfer: async (to, amountRaw, describe) => { state.transfers.push({ to, amountRaw, describe }); return "F".repeat(64); },
      pocket: async () => {},
    },
    usd: deposit,
    validate: (p) => registry.prepareCall(p),
    xnoUsd: 1,
    publicBase: "http://pay.test",
    pollMs: 10,
    waitMs: 300,
    log: () => {},
  });
  const callTool = gate.wrapRegistry(registry).callTool;
  const quote = await callTool({ name: "poster", arguments: { Text: "a" } });
  const paymentId = quote.structuredContent.x402.paymentId;
  state.receivable["C".repeat(64)] = { amount: quote.structuredContent.x402.amountRaw, source: PAYER };
  const res = await callTool({ name: "poster", arguments: { Text: "a", _payment_id: paymentId } });
  assert.equal(res.isError, undefined);
  assert.equal("costUsd" in res, false);
  assert.equal("providerUsd" in res, false);
  assert.equal("billedUsd" in res, false);
  const receipt = res.content.at(-1).text;
  assert.match(receipt, /provider cost \$5\.0000 \(exact\)/);
  assert.match(receipt, /billed \$0\.0500 \(capped at the deposit\)/);
  assert.doesNotMatch(receipt, /lower bound/);
  assert.doesNotMatch(receipt, /settled at actual cost \$5/);
  await new Promise((r) => setTimeout(r, 30));
  const depositRaw = BigInt(quote.structuredContent.x402.amountRaw);
  const sent = state.transfers.reduce((sum, t) => sum + BigInt(t.amountRaw), 0n);
  assert.ok(sent * 20n < depositRaw, "settlement stays inside the deposit; got " + state.transfers.map((t) => t.describe + " " + t.amountRaw).join(", "));
});

test("isBlockedIp allows only global unicast and rejects fec0::/10 and the other non-global IPv6 ranges", () => {
  const blocked = {
    "::/128": ["::", "0:0:0:0:0:0:0:0"],
    "::1/128": ["::1"],
    "100::/64": ["100::", "100::1"],
    "2001::/23": ["2001::", "2001::1", "2001:1::1"],
    "2001:db8::/32": ["2001:db8::", "2001:db8::1"],
    "fc00::/7": ["fc00::1", "fd00::1"],
    "fe80::/10": ["fe80::1", "febf::1"],
    "fec0::/10": ["fec0::1", "feff::ffff"],
    "ff00::/8": ["ff00::1", "ff02::1"],
    "mapped private": ["::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:0.0.0.0", "::ffff:192.0.2.1", "::ffff:169.254.169.254"],
    "nat64 private": ["64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1"],
    "6to4 private": ["2002:a00:1::", "2002:7f00:1::", "2002:c0a8:1::"],
  };
  for (const [range, ips] of Object.entries(blocked)) {
    for (const ip of ips) assert.equal(isBlockedIp(ip), true, `${range} ${ip}`);
  }
  const allowed = ["2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8", "2002:808:808::"];
  for (const ip of allowed) assert.equal(isBlockedIp(ip), false, ip);
});

test("one deadline covers DNS and every redirect hop, and no request is sent after it", async () => {
  let releaseDns;
  let requested = 0;
  const lookup = () => new Promise((resolve) => {
    releaseDns = () => resolve([{ address: "1.2.3.4" }]);
  });
  const request = () => {
    requested++;
    return { status: 200, headers: {}, stream: Readable.from([Buffer.from("x")]) };
  };
  const pending = fetchPublicBytes("http://slow.example/v.mp4", { lookup, request, timeoutMs: 5 });
  const outcome = await Promise.race([
    pending.then(() => ({ ok: true }), (e) => ({ e })),
    new Promise((resolve) => setTimeout(() => resolve({ pending: true }), 250)),
  ]);
  assert.equal(outcome.pending, undefined, "a 5ms budget was still pending while DNS had not resolved");
  assert.match(outcome.e.message, /timed out/);
  assert.equal(requested, 0);
  releaseDns();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(requested, 0, "DNS resolving after the deadline must not send a request");

  let releaseSecond;
  const calls = [];
  const redirectLookup = (host) => {
    if (host === "one.example") return Promise.resolve([{ address: "1.2.3.4" }]);
    return new Promise((resolve) => {
      releaseSecond = () => resolve([{ address: "8.8.8.8" }]);
    });
  };
  const redirectPending = fetchPublicBytes("http://one.example/a", {
    lookup: redirectLookup,
    timeoutMs: 30,
    request: (url) => {
      calls.push(url.hostname);
      return { status: 302, headers: { location: "http://two.example/next" }, stream: Readable.from([]) };
    },
  });
  const second = await Promise.race([
    redirectPending.then(() => ({ ok: true }), (e) => ({ e })),
    new Promise((resolve) => setTimeout(() => resolve({ pending: true }), 250)),
  ]);
  assert.equal(second.pending, undefined, "the redirect hop's DNS was outside the deadline");
  assert.match(second.e.message, /timed out/);
  assert.deepEqual(calls, ["one.example"]);
  releaseSecond();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(calls, ["one.example"], "the hop whose DNS resolved late was not requested");
});

test("a pre-header timeout destroys the request and its socket", async () => {
  const socket = { destroyed: false, destroy() { this.destroyed = true; } };
  const req = { destroyed: false, socket, destroy() { this.destroyed = true; } };
  let registered = false;
  await assert.rejects(fetchPublicBytes("http://ok.example/hang", {
    timeoutMs: 30,
    lookup: async () => [{ address: "1.2.3.4" }],
    request: (url, ip, opts) => {
      assert.equal(ip, "1.2.3.4");
      assert.equal(url.hostname, "ok.example");
      registered = true;
      opts.register(req);
      return new Promise(() => {});
    },
  }), /timed out/);
  assert.equal(registered, true);
  assert.equal(req.destroyed, true, "request.destroy did not run");
  assert.equal(socket.destroyed, true, "the socket was not destroyed");
});

test("unpaid --serve refuses local file inputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sfw-serve-"));
  const secret = join(dir, "secret.jpg");
  const missing = join(dir, "missing.jpg");
  await writeFile(join(dir, "hello.json"), TINY);
  await writeFile(secret, PNG_1);
  utimesSync(secret, 1, Date.now() / 1000);
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [BIN, "--graphs", dir, "--serve", `127.0.0.1:${port}`, "--out", join(dir, "out")], {
    env: { ...process.env, NANOGPT_API_KEY: "test-key", NANOGPT_BASE_URL: "http://127.0.0.1:9" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  const rpc = async (method, params) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    });
    return res.json();
  };
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not listen\n" + stderr)), 8000);
      const wait = () => {
        if (stderr.includes("MCP over HTTP") && stderr.includes("free")) { clearTimeout(t); resolve(); }
      };
      child.stderr.on("data", wait);
      child.once("exit", (code) => { clearTimeout(t); reject(new Error("exited " + code + "\n" + stderr)); });
    });
    assert.match(stderr, /free/);
    assert.doesNotMatch(stderr, /charging/);
    const list = await rpc("tools/list");
    const sfw = list.result.tools.find((t) => t.name === "sfw_check");
    assert.match(sfw.inputSchema.properties.image.description, /does not read local files/);
    assert.doesNotMatch(sfw.inputSchema.properties.image.description, /file path/);
    assert.doesNotMatch(sfw.inputSchema.properties.video.description, /file path/);
    const existing = await rpc("tools/call", { name: "sfw_check", arguments: { image: secret } });
    const absent = await rpc("tools/call", { name: "sfw_check", arguments: { image: missing } });
    assert.equal(existing.error.code, -32602);
    assert.equal(absent.error.code, -32602);
    assert.match(existing.error.message, /does not read local files/);
    assert.equal(existing.error.message, absent.error.message);
    assert.doesNotMatch(existing.error.message, /not found/);
    assert.equal(statSync(secret).atimeMs, 1000, "unpaid --serve stat'd a local file");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
    });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a DASH or HLS manifest cannot make ffprobe or ffmpeg open another local file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sfw-manifest-"));
  const clip = join(dir, "clip.mp4");
  const secret = join(dir, "secret.mp4");
  const orig = mediaProcs.spawn;
  const argvs = [];
  mediaProcs.spawn = (cmd, args, opts) => {
    argvs.push([cmd, ...args]);
    return orig(cmd, args, opts);
  };
  try {
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.4", "-c:v", "mpeg4", clip], { stdio: "ignore" });
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.2", "-c:v", "mpeg4", secret], { stdio: "ignore" });
    utimesSync(secret, 1, Date.now() / 1000);
    const frames = await sampleVideoFrames(clip, 1, { timeoutMs: 15000 });
    assert.equal(frames.length, 1);
    assert.match(frames[0], /^data:image\/jpeg;base64,/);
    assert.ok(argvs.length >= 2, "ffprobe and ffmpeg should both run for a real mp4");
    for (const argv of argvs) {
      const at = argv.indexOf("-protocol_whitelist");
      assert.notEqual(at, -1, argv.join(" "));
      assert.equal(argv[at + 1], "pipe");
      const fmt = argv.indexOf("-f");
      assert.notEqual(fmt, -1);
      assert.ok(["mp4", "mov", "webm", "matroska"].includes(argv[fmt + 1]), argv.join(" "));
      assert.ok(argv.includes("pipe:0"));
      assert.equal(argv.some((a) => String(a).includes(secret)), false);
    }
    assert.ok(["mp4", "mov"].includes(videoContainer(await readFile(clip))), "the generated clip was not detected as mp4 or mov");
    const before = statSync(secret).atimeMs;
    assert.equal(before, 1000);
    const m3u8 = `#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:0.2,\n${secret}\n#EXT-X-ENDLIST\n`;
    const mpd = `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0.2S" minBufferTime="PT1S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="500000"><BaseURL>${secret}</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const spawned = argvs.length;
    for (const body of [m3u8, mpd]) {
      const url = "data:application/octet-stream;base64," + Buffer.from(body).toString("base64");
      await assert.rejects(sampleVideoFrames(url, 1, { timeoutMs: 5000 }), /mp4, mov, webm, or matroska/);
    }
    assert.equal(argvs.length, spawned, "ffmpeg was started for a manifest");
    assert.equal(statSync(secret).atimeMs, before, "the manifest's local target was opened");
  } finally {
    mediaProcs.spawn = orig;
    await rm(dir, { recursive: true, force: true });
  }
});

test("still images skip ffprobe and ffmpeg, including a stdio local file", async () => {
  const { dir } = await loadSfw({ hosted: false });
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ answers: { answer: { type: "noul", noul: 0.91 } }, usage: { cost: 0.000002 } }));
  });
  const port = await listen(server);
  const live = await loadTools({
    dirs: [dir], apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}`, outDir: join(dir, "out"), log: () => {},
  });
  const sfw = live.tools.find((t) => t.name === "sfw_check");
  assert.match(sfw.inputSchema.properties.image.description, /file path/);
  assert.match(sfw.inputSchema.properties.image.description, /Does not use ffmpeg/);
  const orig = mediaProcs.spawn;
  let spawned = 0;
  mediaProcs.spawn = () => { spawned++; throw new Error("ffmpeg was started for a still image"); };
  const file = join(dir, "pixel.png");
  await writeFile(file, PNG_1);
  try {
    const remote = await live.callTool({
      name: "sfw_check",
      arguments: { image: "data:image/png;base64," + PNG_1.toString("base64") },
    });
    assert.equal(JSON.parse(remote.content[0].text).sfw, true);
    const local = await live.callTool({ name: "sfw_check", arguments: { image: file } });
    assert.equal(JSON.parse(local.content[0].text).frames[0].verdict, "yes");
    assert.equal(spawned, 0);

    const wide = Buffer.from(PNG_1);
    wide.writeUInt32BE(2000, 16);
    wide.writeUInt32BE(10, 20);
    await assert.rejects(
      fitStillImage("data:image/png;base64," + wide.toString("base64"), 512, 240000),
      /Still images are not resized with ffmpeg/,
    );
    assert.equal(spawned, 0);
    assert.deepEqual(imageDimensions(PNG_1), { w: 1, h: 1 });
  } finally {
    mediaProcs.spawn = orig;
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
