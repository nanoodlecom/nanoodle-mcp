/**
 * Offline tests for the local-media / ffmpeg startup guard. No network, no spawn,
 * no spend — PATH scan against a scratch dir and graph-node scanning of fake tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import {
  LOCAL_MEDIA_TYPES,
  detectFfmpeg,
  toolsNeedingFfmpeg,
  warnIfFfmpegMissing,
} from "../src/ffmpeg-check.mjs";

const tool = (name, types) => ({ name, wf: { graph: { nodes: types.map((type, i) => ({ id: i, type })) } } });

test("toolsNeedingFfmpeg flags only graphs with a local-media node", () => {
  const tools = [
    tool("alt-text", ["upload", "vision", "text"]),   // safe
    tool("pr-scribe", ["text", "llm", "join"]),        // safe
    tool("favicon", ["image", "resize"]),              // resize -> at risk
    tool("photo-to-video", ["image", "tvideo", "vframes"]), // vframes -> at risk
    tool("sing", ["extractaudio", "lipsync"]),         // extractaudio -> at risk
  ];
  assert.deepEqual(toolsNeedingFfmpeg(tools), ["favicon", "photo-to-video", "sing"]);
});

test("every flagged type is a real node handler name", () => {
  // Guards against typos drifting from nanoodle-js nodes.mjs.
  for (const t of ["resize", "vframes", "combine", "soundtrack", "trim", "extractaudio"]) {
    assert.ok(LOCAL_MEDIA_TYPES.has(t), `${t} should be a local-media type`);
  }
});

test("detectFfmpeg finds an executable on a scratch PATH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ffcheck-"));
  for (const bin of ["ffprobe", "ffmpeg"]) {
    const p = join(dir, bin);
    await writeFile(p, "#!/bin/sh\nexit 0\n");
    await chmod(p, 0o755);
  }
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = dir + delimiter + savedPath;
    const got = await detectFfmpeg();
    assert.equal(got.ok, true);
    assert.equal(got.ffprobe, true);
    assert.equal(got.ffmpeg, true);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("warnIfFfmpegMissing: warns + names tools when PATH has no ffmpeg", async () => {
  const savedPath = process.env.PATH;
  const lines = [];
  try {
    process.env.PATH = ""; // nothing resolvable
    const at = await warnIfFfmpegMissing(
      [tool("favicon", ["image", "resize"]), tool("alt-text", ["vision"])],
      (m) => lines.push(m)
    );
    assert.deepEqual(at, ["favicon"]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /ffprobe and ffmpeg not on PATH/);
    assert.match(lines[0], /favicon/);
    assert.doesNotMatch(lines[0], /alt-text/); // safe tool not named
  } finally {
    process.env.PATH = savedPath;
  }
});

test("warnIfFfmpegMissing: silent when no local-media tools are loaded", async () => {
  const savedPath = process.env.PATH;
  const lines = [];
  try {
    process.env.PATH = ""; // even with ffmpeg absent...
    const at = await warnIfFfmpegMissing([tool("alt-text", ["vision", "text"])], (m) => lines.push(m));
    assert.deepEqual(at, []); // ...no warning, because no tool needs it
    assert.equal(lines.length, 0);
  } finally {
    process.env.PATH = savedPath;
  }
});
