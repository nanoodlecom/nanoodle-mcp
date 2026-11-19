import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { serveHttp } from "../src/http.mjs";

test("the inline song supports byte-range playback and seeking without a generation call", async () => {
  let calls = 0;
  const server = await serveHttp({ host: "127.0.0.1", port: 0, name: "audio", version: "0", publicBase: "http://example.test",
    listTools: () => [], callTool: async () => { calls++; }, log() {} });
  try {
    const url = `http://127.0.0.1:${server.address().port}/examples/sing.mp3`;
    const file = await readFile(new URL("../assets/examples/sing.mp3", import.meta.url));
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.headers.get("content-type"), "audio/mpeg");
    assert.equal(head.headers.get("content-length"), String(file.length)); assert.equal(head.headers.get("accept-ranges"), "bytes");
    for (const [range, start, end] of [["bytes=0-31", 0, 31], ["bytes=-32", file.length - 32, file.length - 1], [`bytes=${file.length - 32}-`, file.length - 32, file.length - 1]]) {
      const response = await fetch(url, { headers: { Range: range } });
      assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${file.length}`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), file.subarray(start, end + 1));
    }
    for (const range of [`bytes=${file.length}-`, "bytes=-0", "bytes=10-5"]) {
      const response = await fetch(url, { headers: { Range: range } });
      assert.equal(response.status, 416); assert.equal(response.headers.get("content-range"), `bytes */${file.length}`);
    }
    assert.equal(calls, 0);
  } finally { await new Promise(r => server.close(r)); }
});
