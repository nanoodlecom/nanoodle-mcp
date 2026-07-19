# noodle-graph.json format reference

The 💾 Save button in the nanoodle editor writes `noodle-graph.json` — a plain
JSON serialization of the graph, no wrapper. This is the file both executors
(`nanoodle` on npm and PyPI) load and run. Normative source:
[`docs/SPEC-format.md` in nanoodle-js](https://github.com/nanoodlecom/nanoodle-js/blob/main/docs/SPEC-format.md)
(mirrored in nanoodle-py); this file is a condensed copy.

## Top-level shape

```json
{
  "v": 1,
  "nodes": [ { "id": "n1", "type": "text", "x": 60, "y": 130, "fields": { "text": "..." }, "w": 220, "name": "optional custom name" } ],
  "links": [ { "id": "l1", "from": { "node": "n1", "port": "text" }, "to": { "node": "n2", "port": "prompt" } } ],
  "nid": 4, "lid": 3,
  "view": { "panX": 40, "panY": 60, "scale": 1 }
}
```

- `v` — format version, always `1`.
- Node: `id` (string, `"nN"`), `type` (see table below), `fields` (type-specific
  parameter bag), `name` (optional user label — becomes the input/output key),
  `x`/`y`/`w`/`sizes` (editor layout only; executors ignore them).
- Link: `{ id, from: { node, port }, to: { node, port } }`. Only matching port
  kinds connect (text | image | audio | video).
- `nid`/`lid`/`view` — editor counters and camera; ignored for execution.
- Everything except `nodes` is optional to a loader — the minimal
  `{ "nodes": [...], "links": [...] }` form is accepted.

## Loader semantics

- Type alias: `audio` → `tts` (legacy saves).
- Links are kept only if both endpoints exist after node filtering.
- Migration: links into a `music`/`tts` node with `to.port === "text"` are
  rewritten to `"prompt"`.
- Media fields are `data:` URLs inline in `fields` (image/audio/video/mask).
  Share links may have them blanked to `""`.
- Every `<textarea>`-style field is also a wireable text input port with port
  name == field name (except on `text`, `choice`, `comment` nodes and the
  `extraJson` field). A wire into a field-port overrides the typed field value
  at run time.

## Node types

Port kinds: text | image | audio | video.

| type | title | static inputs | dynamic inputs | outputs | key fields |
|---|---|---|---|---|---|
| text | Text | — | — | text:text | text (the literal value; NOT wireable) |
| upload | Image input | — | — | image:image | image (data: URL) |
| aupload | Audio input | — | — | audio:audio | audio (data: URL) |
| vupload | Video input | — | — | video:video | video (data: URL) |
| choice | Choice | — | — | text:text | options (newline-separated), selected |
| join | Join | a:text, b:text | — | text:text | sep (default `" "`; literal `"\n"` means newline) |
| llm | LLM | — | img1..:image (vision), audio:audio | text:text | model, system, prompt, temperature, maxTokens, format(Text\|JSON), reasoningEffort, showThinking |
| image | Image | — | — | image:image | model, prompt, size, variations, seed, customCivitaiAir |
| draw | Draw | — | img1..:image | image:image, text:text | model, system, prompt, showThinking |
| edit | Edit | — | image, image2..:image | image:image | model, prompt, size, seed |
| inpaint | Inpaint | image:image, mask:image | — | image:image | model, prompt, size, seed, brush |
| resize | Resize/crop | image:image | — | image:image | mode(fit\|fill\|exact), width, height (LOCAL, browser-only) |
| vision | Vision | image:image | — | text:text | model, q |
| tvideo | Text→Video | — | ref1..:image | video:video | model, prompt, duration, aspect, resolution, modelOpts |
| ivideo | Image→Video | image:image | endframe:image | video:video | model, prompt, duration, aspect, resolution, modelOpts |
| vedit | Video edit | video:video | — | video:video | model, prompt, resolution, modelOpts |
| vframes | Video→frames | video:video | — | frame1..frameN:image | frames(1-12), gap, dir(end\|start) (LOCAL, browser-only) |
| combine | Combine videos | — | clip1..:video | video:video | dedup (LOCAL, browser-only) |
| soundtrack | Soundtrack | video:video, audio:audio | — | video:video | loop (LOCAL, browser-only) |
| lipsync | Avatar/lipsync | image:image, audio:audio | — | video:video | model, prompt, resolution, modelOpts |
| music | Music | — | — | audio:audio | model, prompt, lyrics, instrumental, duration, negative_prompt, seed, extraJson |
| remix | Remix audio | audio:audio | — | audio:audio | model, prompt, lyrics, duration, extraJson |
| tts | Speech | — | — | audio:audio | model, prompt, voice, speed, instructions, extraJson |
| trim | Trim audio | audio:audio | — | audio:audio | start, length (LOCAL, browser-only) |
| extractaudio | Extract audio | video:video | — | audio:audio | start, length (LOCAL, browser-only) |
| transcribe | Transcribe | audio:audio | — | text:text | model, language |
| comment | Comment | — (note; never runs) | — | — | text, color |

Headless executor support: local nodes (text, upload, aupload, vupload, choice,
join, comment) run in-process; NanoGPT nodes (llm, image, draw, edit, inpaint,
vision, tvideo, ivideo, vedit, lipsync, music, remix, tts, transcribe) call the
API; the rows marked LOCAL/browser-only (resize, vframes, combine, soundtrack,
trim, extractaudio) are browser-only media processing — the executors load such
graphs with a warning and fail fast at run with `UnsupportedNodeError`, before
any network call.

Inpaint note: the browser app composites the mask onto black at the source
pixel size; the executor libraries pass your mask through verbatim — supply a
black/white mask (white = repaint) matching the source dimensions.

Display name resolution: `node.name` (trimmed, if set) → the node type's title
→ the type string. Named nodes give you stable, readable input/output keys —
name every node an agent will touch.

## Canonical example

The starter graph (text → LLM prompt-writer → image) with named nodes lives in
this skill at [`examples/poster.noodle-graph.json`](../examples/poster.noodle-graph.json):
`Idea` (text) → llm (`zai-org/glm-5.2`, system = prompt-writer) → `Poster`
(image, `nano-banana-2-lite`, size `1k`). Wires: `n1.text→n2.prompt`,
`n2.text→n3.prompt`.
