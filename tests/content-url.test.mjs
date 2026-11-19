/**
 * Provider-relative content URLs (Grok Imagine returns
 * `/api/generate-video/content?runId=…&model=…`, which 307s with the API key to a
 * private presigned file). Resolved at the node boundary before the next node
 * builds videoUrl / videoDataUrl / image / audio. No live NanoGPT calls.
 *
 * This is nanoodle-js #49 (40679dfe), run against the vendored executor.
 * The harness and the two media fixtures ship inside that tarball.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Workflow, MediaRef, NanoClient } from "nanoodle";
import { MEDIA_INLINE_MAX, dataUrlBytes } from "../node_modules/nanoodle/src/media.mjs";
import { startMockServer, mockOpts, PNG_B64 } from "../node_modules/nanoodle/tests/harness/mock-server.mjs";

const media = (name) => fileURLToPath(new URL("../node_modules/nanoodle/tests/fixtures/media/" + name, import.meta.url));
const KEY = "unit-test-key-do-not-leak";
const RELATIVE = "/api/generate-video/content?runId=grok1&model=grok-imagine-video-1.5-lite";
const PRESIGNED = "https://files.example/clip.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=SUPERSECRET";

function fakeRes({ status = 200, headers = {}, body = "" } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const h = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: h,
    text: async () => buf.toString("utf8"),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    body: { cancel: async () => {} },
  };
}

function client(fetch) {
  return new NanoClient({ apiKey: KEY, baseUrl: "https://nano-gpt.com", fetch });
}

function assertNoSecrets(text, extra = []) {
  const s = String(text);
  assert.equal(s.includes(KEY), false, "API key leaked: " + s);
  assert.equal(/SUPERSECRET/i.test(s), false, "presigned signature leaked: " + s);
  assert.equal(/X-Amz-/i.test(s), false, "presigned query leaked: " + s);
  for (const bit of extra) assert.equal(s.includes(bit), false, bit + " leaked: " + s);
}

test("relative content URL: authed redirect becomes a presigned absolute URL, key stays on the API host", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, redirect: init.redirect });
    return fakeRes({ status: 307, headers: { location: PRESIGNED } });
  };
  const out = await client(fetch).resolveContentUrl(RELATIVE);
  assert.equal(out, PRESIGNED);
  assert.equal(seen.length, 1, "the presigned host is not fetched (and so never sees the key)");
  assert.equal(seen[0].redirect, "manual");
  assert.equal(seen[0].headers.Authorization, "Bearer " + KEY);
  assert.equal(seen[0].headers["x-api-key"], KEY);
  assert.match(seen[0].url, /^https:\/\/nano-gpt\.com\/api\/generate-video\/content\?runId=grok1&model=grok-imagine-video-1\.5-lite$/);
  assert.equal(seen[0].url.includes(KEY), false);
});

test("a 4.9 MB clip still resolves: the redirect URL is returned, the inline cap is not applied", async () => {
  // The real Grok clip was 4.9 MB against a 4.4 MB data-URL budget. Following the
  // redirect must not try to inline those bytes and must not throw.
  const fetch = async () => fakeRes({
    status: 307,
    headers: {
      location: PRESIGNED,
      "content-length": "4900000",
      "content-type": "video/mp4",
    },
  });
  const out = await client(fetch).resolveContentUrl(RELATIVE);
  assert.equal(out, PRESIGNED);
  assert.equal(out.startsWith("data:"), false);
  assert.ok(out.length < MEDIA_INLINE_MAX);
});

test("relative Location is joined onto the API origin and not downloaded", async () => {
  const fetch = async (url) => {
    assert.match(String(url), /^https:\/\/nano-gpt\.com\/api\//);
    return fakeRes({ status: 302, headers: { location: "/files/clip.mp4?X-Amz-Signature=SUPERSECRET" } });
  };
  const out = await client(fetch).resolveContentUrl(RELATIVE);
  assert.equal(out, "https://nano-gpt.com/files/clip.mp4?X-Amz-Signature=SUPERSECRET");
});

test("same-origin /api URL and a second /api hop are followed; image and audio paths use the same resolver", async () => {
  const presigned = {
    "/api/generate-video/content": "https://files.example/v.mp4?X-Amz-Signature=SUPERSECRET",
    "/api/images/content": "https://files.example/i.png?X-Amz-Signature=SUPERSECRET",
    "/v1/audio/content": "https://files.example/a.mp3?X-Amz-Signature=SUPERSECRET",
  };
  const fetch = async (url) => {
    const u = new URL(url);
    assert.equal(u.origin, "https://nano-gpt.com");
    const target = presigned[u.pathname];
    assert.ok(target, u.pathname);
    return fakeRes({ status: 307, headers: { location: target } });
  };
  const c = client(fetch);
  assert.equal(
    await c.resolveContentUrl("https://nano-gpt.com/api/generate-video/content?runId=1&model=grok"),
    presigned["/api/generate-video/content"],
  );
  assert.equal(await c.resolveContentUrl("/api/images/content?id=img1"), presigned["/api/images/content"]);
  assert.equal(await c.resolveContentUrl("/v1/audio/content?runId=a1"), presigned["/v1/audio/content"]);
});

test("200 body under the cap is inlined as a data URL; over the cap throws without secrets", async () => {
  const mp4 = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const small = await client(async () => fakeRes({
    status: 200,
    headers: { "content-type": "video/mp4" },
    body: mp4,
  })).resolveContentUrl(RELATIVE);
  assert.match(small, /^data:video\/mp4;base64,/);
  assert.ok(small.length <= MEDIA_INLINE_MAX);
  assert.deepEqual(Buffer.from(dataUrlBytes(small).bytes), mp4);

  await assert.rejects(
    client(async () => fakeRes({
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": "4900000" },
      body: "not-inlined",
    })).resolveContentUrl(RELATIVE),
    (e) => {
      assert.match(e.message, /too large to send inline/);
      assert.match(e.message, /did not redirect/);
      assertNoSecrets(e.message, ["grok1", "not-inlined"]);
      return true;
    },
  );
});

test("failed content fetch scrubs the API key and presigned query from the error", async () => {
  const fetch = async () => fakeRes({
    status: 500,
    body: "bad " + KEY + " Bearer " + KEY + " see https://files.example/a.mp4?X-Amz-Signature=SUPERSECRET",
  });
  await assert.rejects(client(fetch).resolveContentUrl(RELATIVE), (e) => {
    assert.match(e.message, /HTTP 500/);
    assertNoSecrets(e.message, ["grok1", "grok-imagine"]);
    return true;
  });
});

test("credentials go only to the exact content paths; other same-origin /api and /v1 URLs are not fetched", async () => {
  const secret = "account-balance-secret";
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), authorization: init && init.headers && init.headers.Authorization, apiKey: init && init.headers && init.headers["x-api-key"] });
    return fakeRes({ status: 200, headers: { "content-type": "application/json" }, body: secret });
  };
  const c = client(fetch);
  const blocked = [
    "https://nano-gpt.com/api/v1/models",
    "https://nano-gpt.com/api/user/me",
    "https://nano-gpt.com/v1/chat/completions",
    "/api/generate-video/content/extra",
    "/api/generate-video/content/",
    "/v1/audio/content/extra",
    "https://nano-gpt.com/api/upload?id=user-file",
    "/api/upload/pic.png",
  ];
  for (const url of blocked) {
    seen.length = 0;
    await assert.rejects(c.resolveContentUrl(url), (e) => {
      assert.match(e.message, /not a provider content file/);
      assert.equal(e.message.includes(secret), false);
      assert.equal(e.message.includes(KEY), false);
      return true;
    });
    assert.equal(seen.length, 0, url + " was fetched");
  }
});

test("a user-supplied same-origin upload URL outside /api and /v1 is not fetched and gets no credentials", async () => {
  let fetched = 0;
  const fetch = async () => { fetched++; return fakeRes({ status: 200, body: "upload-bytes" }); };
  const c = client(fetch);
  const abs = "https://nano-gpt.com/uploads/user/pic.png";
  assert.equal(await c.resolveContentUrl(abs), abs);
  assert.equal(await c.resolveContentUrl("/uploads/user/pic.png"), abs);
  assert.equal(fetched, 0);
});

test("a cross-site /api URL is not fetched and never sees the API key", async () => {
  let fetched = 0;
  const fetch = async (_url, init) => {
    fetched++;
    assert.equal(init && init.headers && init.headers.Authorization, undefined);
    return fakeRes({ status: 200, body: "offsite" });
  };
  const url = "https://evil.example/api/generate-video/content?runId=1";
  assert.equal(await client(fetch).resolveContentUrl(url), url);
  assert.equal(fetched, 0);
});

test("a content redirect onto another same-origin /api path is not followed with credentials and its body is not inlined", async () => {
  const secret = "whoami-secret-body";
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), authorization: init.headers && init.headers.Authorization });
    const u = new URL(url);
    if (u.pathname === "/api/generate-video/content") {
      return fakeRes({ status: 307, headers: { location: "/api/v1/whoami" } });
    }
    return fakeRes({ status: 200, headers: { "content-type": "application/json" }, body: secret });
  };
  await assert.rejects(client(fetch).resolveContentUrl(RELATIVE), /not a provider content file/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].authorization, "Bearer " + KEY);
  assert.match(seen[0].url, /\/api\/generate-video\/content/);
  assert.equal(JSON.stringify(seen).includes(secret), false);
});

test("ordinary https and data URLs are not fetched; a public relative file becomes absolute", async () => {
  const fetch = async () => { throw new Error("should not fetch " + KEY + " " + PRESIGNED); };
  const c = client(fetch);
  assert.equal(await c.resolveContentUrl("https://cdn.example/ok.mp4"), "https://cdn.example/ok.mp4");
  assert.equal(await c.resolveContentUrl("data:video/mp4;base64,AAAA"), "data:video/mp4;base64,AAAA");
  assert.equal(await c.resolveContentUrl("/files/clip.mp4"), "https://nano-gpt.com/files/clip.mp4");
});

test("MediaRef download errors omit the presigned query and the API key", async () => {
  const url = "https://files.example/clip.mp4?X-Amz-Signature=SUPERSECRET&X-Api-Key=" + KEY;
  const ref = new MediaRef(url, { fetch: async () => ({ ok: false, status: 403, headers: new Headers() }) });
  await assert.rejects(ref.bytes(), (e) => {
    assert.match(e.message, /403/);
    assert.match(e.message, /https:\/\/files\.example\/clip\.mp4/);
    assertNoSecrets(e.message);
    return true;
  });
});

/* ---------- node boundary: inline fallback (under the cap) ---------- */

test("vedit receives a data URL when the content endpoint returns the bytes", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const mp4 = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  srv.script("POST /api/generate-video", [
    { json: { runId: "grok1", cost: 0.1 } },
    { json: { runId: "ext1", cost: 0.125 } },
  ]);
  srv.script("GET /api/video/status", [
    { json: { status: "COMPLETED", output: { video: { url: RELATIVE } } } },
    { json: { status: "COMPLETED", output: { url: "https://cdn.example/ext.mp4" } } },
  ]);
  srv.script("GET /api/generate-video/content", {
    status: 200,
    headers: { "content-type": "video/mp4" },
    body: mp4,
  });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "open", type: "tvideo", name: "Open", fields: { model: "grok-imagine-video-1.5-lite", prompt: "a boat" } },
      { id: "ext1", type: "vedit", name: "Extend", fields: { model: "minimax/h3-max-turbo/extend-video", prompt: "keep sailing", modelOpts: { output: "extended" } } },
    ],
    links: [{ id: "l", from: { node: "open", port: "video" }, to: { node: "ext1", port: "video" } }],
  }, mockOpts(srv, { apiKey: KEY }));
  const result = await wf.run({});
  const body = srv.of("POST /api/generate-video")[1].json;
  assert.equal(body.model, "minimax/h3-max-turbo/extend-video");
  assert.equal(body.videoDataUrl.startsWith("data:video/mp4;base64,"), true);
  assert.equal("videoUrl" in body, false);
  assert.equal(body.videoDataUrl.includes(RELATIVE), false);
  assert.ok(body.videoDataUrl.length <= MEDIA_INLINE_MAX);
  assert.equal(result.nodes.open.out.video, body.videoDataUrl);
  const content = srv.of("GET /api/generate-video/content")[0];
  assert.equal(content.headers.authorization, "Bearer " + KEY);
  assert.equal(content.query.runId, "grok1");
  assertNoSecrets(JSON.stringify(result.errors));
});

/* ---------- image + audio inputs, same boundary ---------- */

test("image and audio inputs receive the resolved absolute URL, not the relative content path", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const imgSigned = srv.url + "/files/pic.png?X-Amz-Signature=SUPERSECRET";
  const audSigned = srv.url + "/files/score.mp3?X-Amz-Signature=SUPERSECRET";
  srv.script("POST /v1/images/generations", [
    { json: { data: [{ url: "/api/images/content?id=img1" }], cost: 0.01 } },
    { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } },
  ]);
  srv.script("GET /api/images/content", { status: 307, headers: { location: imgSigned }, body: "" });
  srv.script("POST /api/v1/audio/speech", [
    { json: { url: "/v1/audio/content?runId=a1", cost: 0.045 } },
    { json: { url: "https://cdn.example/cover.mp3", cost: 0.05 } },
  ]);
  srv.script("GET /v1/audio/content", { status: 307, headers: { location: audSigned }, body: "" });

  const img = Workflow.fromJSON({
    nodes: [
      { id: "im", type: "image", name: "Still", fields: { model: "flux", prompt: "a paper boat", size: "1024x1024" } },
      { id: "ed", type: "edit", name: "Grade", fields: { model: "flux-edit", prompt: "warmer", size: "1024x1024" } },
    ],
    links: [{ id: "l", from: { node: "im", port: "image" }, to: { node: "ed", port: "image" } }],
  }, mockOpts(srv, { apiKey: KEY }));
  const imgResult = await img.run({});
  const edit = srv.of("POST /v1/images/generations")[1].json;
  assert.equal(edit.imageDataUrl, imgSigned);
  assert.equal(imgResult.nodes.im.out.image, imgSigned);
  assert.equal(imgResult.nodes.im.out.images[0], imgSigned);
  assert.equal(srv.of("GET /api/images/content").length, 1, "image + images[] share one fetch");

  const aud = Workflow.fromJSON({
    nodes: [
      { id: "m", type: "music", name: "Score", fields: { model: "mureka-ai/mureka-v7.6/generate-bgm", prompt: "soft guitar", instrumental: true } },
      { id: "r", type: "remix", name: "Cover", fields: { model: "cover-model", prompt: "brighter" } },
    ],
    links: [{ id: "l", from: { node: "m", port: "audio" }, to: { node: "r", port: "audio" } }],
  }, mockOpts(srv, { apiKey: KEY }));
  const audResult = await aud.run({});
  const remix = srv.of("POST /api/v1/audio/speech")[1].json;
  assert.equal(remix.audio, audSigned);
  assert.match(remix.audio, /^https?:\/\//);
  assert.equal(audResult.nodes.m.out.audio, audSigned);
  assert.equal(srv.of("GET /files/pic.png").length, 0);
  assert.equal(srv.of("GET /files/score.mp3").length, 0);
  for (const r of srv.requests) {
    if (r.path.startsWith("/files/")) {
      assert.equal(r.headers.authorization, undefined);
      assert.equal(r.headers["x-api-key"], undefined);
    }
  }
  assertNoSecrets(JSON.stringify(imgResult.errors) + JSON.stringify(audResult.errors));
});

/* ---------- 3-stage graph: Grok relative URL → H3 extend → extend → soundtrack ---------- */

test("one-take graph: Grok relative URL is a readable absolute videoUrl and the graph completes", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const mp4 = await readFile(media("clipA.mp4"));
  const wav = await readFile(media("nn-tone.wav"));
  const presigned = srv.url + "/files/grok.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=SUPERSECRET";
  const ext1Url = srv.url + "/files/ext1.mp4";
  const ext2Url = srv.url + "/files/ext2.mp4";
  const scoreUrl = srv.url + "/files/score.wav";

  srv.script("POST /api/generate-video", [
    { json: { runId: "grok1", cost: 0.1 } },
    { json: { runId: "ext1", cost: 0.125 } },
    { json: { runId: "ext2", cost: 0.125 } },
  ]);
  srv.script("GET /api/video/status", [
    { json: { status: "COMPLETED", output: { video: { url: RELATIVE } } } },
    { json: { status: "COMPLETED", output: { video: { url: ext1Url } } } },
    { json: { status: "COMPLETED", output: { video: { url: ext2Url } } } },
  ]);
  srv.script("GET /api/generate-video/content", { status: 307, headers: { location: presigned }, body: "" });
  srv.script("GET /files/grok.mp4", { headers: { "content-type": "video/mp4" }, body: mp4 });
  srv.script("GET /files/ext1.mp4", { headers: { "content-type": "video/mp4" }, body: mp4 });
  srv.script("GET /files/ext2.mp4", { headers: { "content-type": "video/mp4" }, body: mp4 });
  srv.script("GET /files/score.wav", { headers: { "content-type": "audio/wav" }, body: wav });
  srv.script("POST /api/v1/audio/speech", { json: { url: scoreUrl, cost: 0.045 } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "c-intent", type: "comment", fields: { text: "One continuous take." } },
      { id: "shot", type: "text", name: "Shot", fields: { text: "A paper sailboat in a rain gutter. One continuous tracking shot, no cuts." } },
      { id: "beat1", type: "text", name: "Continue 1", fields: { text: "The boat keeps sailing. Continuous shot, no cuts." } },
      { id: "beat2", type: "text", name: "Continue 2", fields: { text: "The gutter opens onto a puddle. Continuous shot, no cuts." } },
      {
        id: "open", type: "tvideo", name: "Opening 5 s · Grok Imagine 1.5 Lite",
        fields: { model: "grok-imagine-video-1.5-lite", prompt: "", duration: "5", resolution: "480p", aspect: "16:9", modelOpts: {}, loras: [] },
      },
      {
        id: "ext1", type: "vedit", name: "Extend +5 s · H3 Max Turbo",
        fields: { model: "minimax/h3-max-turbo/extend-video", prompt: "", resolution: "480p", duration: "5", modelOpts: { output: "extended" } },
      },
      {
        id: "ext2", type: "vedit", name: "Extend +5 s again · H3 Max Turbo",
        fields: { model: "minimax/h3-max-turbo/extend-video", prompt: "", resolution: "480p", duration: "5", modelOpts: { output: "extended" } },
      },
      {
        id: "score", type: "music", name: "Score · Mureka BGM",
        fields: { model: "mureka-ai/mureka-v7.6/generate-bgm", instrumental: true, response_format: "mp3", prompt: "Gentle hopeful instrumental." },
      },
      { id: "final", type: "soundtrack", name: "One take · score laid on", fields: { loop: false } },
    ],
    links: [
      { id: "l1", from: { node: "shot", port: "text" }, to: { node: "open", port: "prompt" } },
      { id: "l2", from: { node: "open", port: "video" }, to: { node: "ext1", port: "video" } },
      { id: "l3", from: { node: "beat1", port: "text" }, to: { node: "ext1", port: "prompt" } },
      { id: "l4", from: { node: "ext1", port: "video" }, to: { node: "ext2", port: "video" } },
      { id: "l5", from: { node: "beat2", port: "text" }, to: { node: "ext2", port: "prompt" } },
      { id: "l6", from: { node: "ext2", port: "video" }, to: { node: "final", port: "video" } },
      { id: "l7", from: { node: "score", port: "audio" }, to: { node: "final", port: "audio" } },
    ],
  }, mockOpts(srv, { apiKey: KEY }));

  const result = await wf.run({});
  const submits = srv.of("POST /api/generate-video");
  assert.equal(submits.length, 3);
  const ext1 = submits[1].json;
  const ext2 = submits[2].json;
  assert.equal(ext1.model, "minimax/h3-max-turbo/extend-video");
  assert.equal(ext1.output, "extended");
  assert.equal(ext1.videoUrl, presigned);
  assert.equal("videoDataUrl" in ext1, false);
  assert.equal(ext1.videoUrl.includes(RELATIVE), false);
  assert.equal(ext1.videoUrl.includes(KEY), false);
  assert.equal(ext2.videoUrl, ext1Url);
  assert.equal("videoDataUrl" in ext2, false);
  assert.match(ext2.videoUrl, /^https?:\/\//);

  // The Grok node's own output is an absolute URL the caller can fetch, query included
  // so the private file opens. The key is not in it.
  assert.equal(result.nodes.open.out.video, presigned);
  assert.equal(result.nodes.open.out.video.includes(KEY), false);
  assert.match(result.nodes.ext1.out.video, /^https?:\/\//);
  assert.match(result.nodes.ext2.out.video, /^https?:\/\//);

  const got = await fetch(presigned);
  assert.equal(got.status, 200);
  const bytes = new Uint8Array(await got.arrayBuffer());
  assert.ok(bytes.length > 1000);
  assert.equal(Buffer.compare(Buffer.from(bytes), mp4), 0);

  const content = srv.of("GET /api/generate-video/content");
  assert.equal(content.length, 1);
  assert.equal(content[0].headers.authorization, "Bearer " + KEY);
  assert.equal(content[0].headers["x-api-key"], KEY);
  assert.equal(content[0].query.model, "grok-imagine-video-1.5-lite");
  for (const r of srv.requests) {
    if (r.path.startsWith("/files/")) {
      assert.equal(r.headers.authorization, undefined, r.path);
      assert.equal(r.headers["x-api-key"], undefined, r.path);
    }
  }

  const final = result.get("One take · score laid on");
  assert.ok(final instanceof MediaRef);
  const muxed = await final.bytes();
  assert.ok(muxed.length > 500);
  assert.equal(result.errors.length, 0);
  assert.equal(Math.round(result.costUsd * 1000) / 1000, 0.395);
  const leaked = JSON.stringify(result.errors) + (result.nodes.open.error || "") + (result.nodes.ext1.error || "");
  assertNoSecrets(leaked);
});
