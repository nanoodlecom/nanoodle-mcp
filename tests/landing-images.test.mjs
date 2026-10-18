import { test } from "node:test";
import assert from "node:assert/strict";
import { serveHttp } from "../src/http.mjs";

// nanoodle.com sends Cross-Origin-Resource-Policy: same-origin, so a browser on the
// mcp host blocks any image hotlinked from it. Every landing-page <img> must come
// from this server or from nanoodle's media host.
// The 10 tools the hosted server mounts (mcp.nanoodle.com tools/list).
const LIVE_TOOLS = ["character-sprites", "image-model-arena", "neon-shrine-duel", "photo-to-video", "sing", "storyboard-relay", "talking-avatar", "tiny-world-film", "idea-to-3d-model", "mix-the-references"];
const PUBLIC_BASE = "https://mcp.nanoodle.com";
const MEDIA_ORIGIN = "https://media.nanoodle.com";
// The media check makes real (free) HEAD requests. Set NANOODLE_OFFLINE=1 to skip it.
const OFFLINE = process.env.NANOODLE_OFFLINE === "1";

async function landingImgSrcs() {
  const tools = LIVE_TOOLS.map(name => ({ name, description: `${name} workflow`, inputSchema: { type: "object" } }));
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "landing-images", version: "0",
    publicBase: PUBLIC_BASE, log: () => {},
    listTools: () => tools, callTool: async () => { throw new Error("No generation in this test"); },
    toolInfo: tools.map(tool => ({ ...tool, rawText: "{}", editorUrl: "https://nanoodle.com/#g=test" })),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    const html = await page.text();
    const srcs = [...html.matchAll(/<img\b[^>]*?\bsrc="([^"]*)"/g)].map(m => m[1].replace(/&amp;/g, "&"));
    const local = [];
    for (const src of srcs.filter(s => new URL(s, PUBLIC_BASE + "/").origin === PUBLIC_BASE)) {
      const url = new URL(src, PUBLIC_BASE + "/");
      const res = await fetch(base + url.pathname + url.search);
      local.push({ src, status: res.status, type: res.headers.get("content-type") });
      await res.arrayBuffer();
    }
    return { html, srcs, local };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("landing page images are same-origin or on media.nanoodle.com", async () => {
  const { html, srcs, local } = await landingImgSrcs();
  // favicon + six sample previews (sing has no preview; neon-shrine-duel,
  // storyboard-relay and tiny-world-film have no example)
  assert.equal(srcs.length, 7, `expected 7 <img>, got ${JSON.stringify(srcs)}`);
  for (const src of srcs) {
    const origin = new URL(src, PUBLIC_BASE + "/").origin;
    assert.ok(origin === PUBLIC_BASE || origin === MEDIA_ORIGIN, `${src} is neither same-origin nor on ${MEDIA_ORIGIN}`);
  }
  assert.doesNotMatch(html, /<img\b[^>]*src="https?:\/\/(?:www\.)?nanoodle\.com\//);
  for (const { src, status, type } of local) {
    assert.equal(status, 200, `${src} -> ${status}`);
    assert.match(type || "", /^image\//, `${src} content-type`);
  }
});

test("landing page media images return 200, an image type and no same-origin CORP", { skip: OFFLINE && "NANOODLE_OFFLINE=1" }, async () => {
  const { srcs } = await landingImgSrcs();
  const media = srcs.filter(src => new URL(src, PUBLIC_BASE + "/").origin === MEDIA_ORIGIN);
  assert.equal(media.length, 6, `expected 6 media images, got ${JSON.stringify(media)}`);
  for (const src of media) {
    const res = await fetch(src, { method: "HEAD", headers: { Origin: PUBLIC_BASE }, signal: AbortSignal.timeout(15000) });
    assert.equal(res.status, 200, `${src} -> ${res.status}`);
    assert.match(res.headers.get("content-type") || "", /^image\//, `${src} content-type`);
    const corp = (res.headers.get("cross-origin-resource-policy") || "").trim().toLowerCase();
    assert.ok(corp === "" || corp === "cross-origin", `${src} sends Cross-Origin-Resource-Policy: ${corp}`);
  }
});
