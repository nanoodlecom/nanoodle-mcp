import { test } from "node:test";
import assert from "node:assert/strict";
import { serveHttp } from "../src/http.mjs";
import { ARTICLES, GUIDES, INTRO, PROFILE, orderedArticles, pageThumb } from "../src/receipts.mjs";

async function withServer(charged, fn) {
  const tools = [{ name: "poster", description: "poster workflow" }];
  const server = await serveHttp({
    host: "127.0.0.1", port: 0, name: "receipts", version: "0",
    publicBase: "https://mcp.nanoodle.com", log: () => {},
    gate: charged ? {} : null,
    listTools: () => tools,
    callTool: async () => { throw new Error("no generation"); },
    toolInfo: [{ name: "poster", rawText: "{}", editorUrl: "https://nanoodle.com/#g=test" }],
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function section(html) {
  const start = html.indexOf('<section class="receipts"');
  const end = html.indexOf("</section>", start);
  assert.ok(start >= 0 && end > start, "receipts section missing");
  return html.slice(start, end);
}

test("page thumbs stay on the media host", () => {
  for (const article of ARTICLES) {
    const thumb = pageThumb(article);
    if (thumb) assert.ok(thumb.startsWith("https://media.nanoodle.com/"), thumb);
    else assert.match(article.thumb, /^https:\/\/(?!media\.nanoodle\.com\/)/);
  }
  const [newest] = orderedArticles();
  assert.equal(newest.key, "tin-robot");
  assert.equal(pageThumb(newest), "https://media.nanoodle.com/subnano/2026-10-21-song-to-music-video/poster.webp");
});

test("landing receipts sit between the flow strip and the cost card", async () => {
  const html = await withServer(true, async (base) => await (await fetch(`${base}/`)).text());
  const flow = html.indexOf("No tab, no tip, no signup.");
  const runs = html.indexOf("Real runs, real receipts");
  const cost = html.indexOf("What a call costs");
  assert.ok(flow >= 0 && runs > flow && cost > runs, "section is out of order");

  const block = section(html);
  assert.ok(block.includes(INTRO));
  assert.ok(block.includes("Open in Subnano →"));
  assert.ok(block.includes(`Read all of Nano Maxi's notes →`));
  assert.ok(block.includes(`href="${PROFILE}"`));

  const articles = orderedArticles();
  const hero = articles[0];
  assert.ok(block.includes(`href="${hero.url}"`));
  assert.ok(block.includes("· newest · 2026-10-21"));
  for (const article of articles) {
    assert.ok(block.includes(article.title), article.key);
    assert.ok(block.includes(`href="${article.url}"`), article.key);
    assert.ok(block.includes(article.blurb) === (article === hero), `${article.key} blurb visibility`);
  }
  for (const guide of GUIDES) {
    assert.ok(block.includes(guide.title), guide.href);
    assert.ok(block.includes(`href="${guide.href}"`), guide.href);
  }

  const links = [...block.matchAll(/<a\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(links.length, 1 + (articles.length - 1) + GUIDES.length + 1);
  for (const link of links) {
    assert.match(link, /target="_blank"/);
    assert.match(link, /rel="noopener"/);
  }
  const img = [...block.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(img.length, 1);
  assert.match(img[0], /loading="lazy"/);
  assert.match(img[0], /src="https:\/\/media\.nanoodle\.com\/subnano\/2026-10-21-song-to-music-video\/poster\.webp"/);
  assert.doesNotMatch(block, /supabase\.co/);
});

test("free-mode landing still shows receipts and skips the payment story", async () => {
  const html = await withServer(false, async (base) => await (await fetch(`${base}/`)).text());
  assert.doesNotMatch(html, /What a call costs/);
  assert.doesNotMatch(html, /deposit/i);
  const steps = html.indexOf("paste the command");
  const runs = html.indexOf("Real runs, real receipts");
  const workflows = html.indexOf("Workflows (");
  assert.ok(steps >= 0 && runs > steps && workflows > runs);
  assert.ok(section(html).includes(INTRO));
});

test("llms.txt carries a short receipts version ahead of the tool list", async () => {
  const txt = await withServer(true, async (base) => await (await fetch(`${base}/llms.txt`)).text());
  const runs = txt.indexOf("## Real runs, real receipts");
  const tools = txt.indexOf("## Tools");
  assert.ok(runs >= 0 && tools > runs);
  assert.ok(txt.includes(INTRO));
  assert.ok(txt.includes(`Open in Subnano: ${orderedArticles()[0].url}`));
  assert.ok(txt.includes(`Read all of Nano Maxi's notes: ${PROFILE}`));
  for (const article of ARTICLES) {
    assert.ok(txt.includes(article.title), article.key);
    assert.ok(txt.includes(article.url), article.key);
    assert.ok(txt.includes(article.blurb), article.key);
  }
  for (const guide of GUIDES) {
    assert.ok(txt.includes(guide.title));
    assert.ok(txt.includes(guide.href));
  }
});
