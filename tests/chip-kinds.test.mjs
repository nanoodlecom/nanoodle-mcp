/**
 * Guard: the landing page's chip-tint table may only name node types the
 * installed `nanoodle` library still supports — fully offline.
 *
 * loadTools refuses any graph the library warns about, so a graph containing a
 * retired node type never becomes a tool and never reaches chainSteps. A
 * retired key in CHIP_KINDS is therefore dead, and it reads as support that no
 * longer exists. The table had two dead keys: `draw` (retired 2026-07-22, when
 * NanoGPT dropped the gemini-omni chat-image contract) and `audio` (the audio
 * input node is `aupload`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NODE_TYPES } from "nanoodle";
import { CHIP_KINDS } from "../src/tools.mjs";

test("every CHIP_KINDS key is a live nanoodle node type", () => {
  const dead = Object.keys(CHIP_KINDS).filter((t) => !NODE_TYPES[t]);
  assert.deepEqual(
    dead,
    [],
    `CHIP_KINDS names node type(s) nanoodle no longer has: ${dead.join(", ")}. ` +
      "Drop them — loadTools rejects graphs that use them, so the tint is never applied.",
  );
});

test("every CHIP_KINDS value is one of the tints the landing page styles", () => {
  const tints = new Set(["text", "llm", "image", "video", "audio"]);
  for (const [type, kind] of Object.entries(CHIP_KINDS)) {
    assert.ok(tints.has(kind), `CHIP_KINDS.${type} = "${kind}" is not a styled tint`);
  }
});
