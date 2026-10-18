import { test } from "node:test";
import assert from "node:assert/strict";
import { serveHttp } from "../src/http.mjs";

// nanoodle.com sends Cross-Origin-Resource-Policy: same-origin, so a browser on the
// mcp host blocks any image hotlinked from it. Every landing-page <img> must be
// served by this server itself.
const LIVE_TOOLS = ["character-sprites", "image-model-arena", "photo-to-video", "talking-avatar", "sing", "storyboard-relay"];
const PUBLIC_BASE = "https://mcp.nanoodle.com";

test("landing page images are same-origin and served as images", async () => {
  const tools = LIVE_TOOLS.map(name => ({ name, description: `${name} workflow`, inputSchema: { type: "object" } }));
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "landing-images", version: "0",
    publicBase: PUBLIC_BASE, log: () => {},
    listTools: () => tools, callTool: async () => { throw new Error("No generation in this test"); },
    toolInfo: tools.map(tool => ({ ...tool, rawText: "{}", editorUrl: "https://nanoodle.com/#g=test" })),
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    const html = await page.text();
    const srcs = [...html.matchAll(/<img\b[^>]*?\bsrc="([^"]*)"/g)].map(m => m[1].replace(/&amp;/g, "&"));
    // favicon + the four sample previews (sing has no preview, storyboard-relay no example)
    assert.equal(srcs.length, 5, `expected 5 <img>, got ${JSON.stringify(srcs)}`);
    for (const src of srcs) {
      const resolved = new URL(src, PUBLIC_BASE + "/");
      assert.equal(resolved.origin, PUBLIC_BASE, `${src} is not same-origin`);
      assert.ok(src.startsWith("/") || src.startsWith(PUBLIC_BASE + "/"), `${src} must be relative or on the mcp host`);
      const res = await fetch(base + resolved.pathname + resolved.search);
      assert.equal(res.status, 200, `${src} -> ${res.status}`);
      assert.match(res.headers.get("content-type") || "", /^image\//, `${src} content-type`);
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(body.length > 100, `${src} body is ${body.length} bytes`);
      const magic = body.subarray(0, 12);
      const isPng = magic.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const isWebp = magic.subarray(0, 4).toString("latin1") === "RIFF" && magic.subarray(8, 12).toString("latin1") === "WEBP";
      const type = res.headers.get("content-type");
      if (type === "image/png") assert.ok(isPng, `${src} is not a PNG`);
      if (type === "image/webp") assert.ok(isWebp, `${src} is not a WebP`);
    }
    assert.doesNotMatch(html, /<img\b[^>]*src="https?:\/\/(?!mcp\.nanoodle\.com\/)/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
