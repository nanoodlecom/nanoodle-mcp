// Preview images live on nanoodle's media host (R2 bucket nanoodle-media), not
// nanoodle.com: nanoodle.com sends Cross-Origin-Resource-Policy: same-origin, so a
// browser on the mcp host blocks images hotlinked from it.
const MEDIA_EXAMPLES = "https://media.nanoodle.com/mcp/examples";
const MEDIA_PREVIEWS = new Set(["image-model-arena", "photo-to-video", "talking-avatar"]);

// Only link reviewed, published samples; a call template is not output evidence.
function reviewedSample(slug, description, alt) {
  const preview = MEDIA_PREVIEWS.has(slug) ? `${MEDIA_EXAMPLES}/${slug}.webp` : `https://nanoodle.com/examples/gallery/${slug}/preview.webp`;
  return {
    title: "Reviewed sample",
    play: `https://nanoodle.com/examples/gallery/#${slug}`,
    ...(alt ? { preview, alt } : {}),
    description,
  };
}

// Outcome examples belong to the mounted workflow, not the server's default tool set.
const WORKFLOW_EXAMPLES = {
  "favicon": reviewedSample("favicon", "A lighthouse-inspired icon for a pocket weather radio. The output is a raster concept; creating an ICO or SVG requires a separate step.", "Lighthouse-inspired square icon for the Lumen weather radio"),
  "fibo-studio-still": reviewedSample("fibo-studio-still", "An amber soap bottle rendered from a product brief and lighting choice. This is a generated concept, not a photograph of an existing product.", "Generated amber soap bottle studio still"),
  "night-market-postcard": reviewedSample("night-market-postcard", "An illustrated Raohe night-market postcard from the saved place and atmosphere inputs. Use it as creative artwork rather than a documentary record.", "Illustrated Taipei night-market postcard"),
  "image-model-arena": reviewedSample("image-model-arena", "The same bicycle-repair poster brief sent to four image models. All four retained the requested text in this run; only Grok rendered recognizable tire levers. Compare all outputs before choosing.", "Four image model outputs for a bicycle-repair workshop poster"),
  "edit-a-photo": reviewedSample("edit-a-photo", "A bottle image edit with its source and instruction documented in the sample. The shape remains recognizable; compare any markings that must survive an edit of your own product.", "Reviewed bottle image edit result"),
  "combine-images": reviewedSample("combine-images", "A bottle and a mug-on-desk source image combined into one plausible scene. The sample includes both inputs; exact product fidelity needs a separate comparison.", "Bottle combined with a mug-on-desk source image"),
  "photo-to-video": reviewedSample("photo-to-video", "A short tea-on-a-desk animation. Sampled frames retained the mug while steam moved. This thumbnail is one frame; the example does not establish a seamless loop.", "Frame from a generated tea-on-a-desk video"),
  "omni-flash-turntable": reviewedSample("omni-flash-turntable", "A 360p draft camera orbit around a generated bottle with coherent geometry in the reviewed clip. This thumbnail is one frame; open the sample to inspect the motion.", "Frame from a generated water-bottle product video"),
  "deslop": reviewedSample("deslop", "A repair-booking announcement rewritten in plain language while retaining the supplied facts. Compare the source and result in the sample; this is an editorial workflow, not an authorship detector."),
  "render-a-mockup": reviewedSample("render-a-mockup", "A repair-shop dashboard concept with the requested navigation, date, three appointment rows, names, statuses and totals. This is a rendered screen concept; implementation and interaction are separate work.", "Repair-shop dashboard concept with three appointment rows"),
  "sing": {
    ...reviewedSample("sing", "A 170-second generated closing-credits song. Gemini 3.8 Flash reported clear gentle acoustic vocals and a chorus matching the supplied lyrics. This is model-assisted audio review, not human listening sign-off."),
    title: "Audio sample",
  },
  "talking-avatar": {
    ...reviewedSample("talking-avatar", "A fictional presenter reads a short workshop introduction. Sampled frames preserve the presenter; check precise lip-sync timing in playback. Generation can take several minutes.", "Frame from a fictional presenter's workshop introduction"),
    title: "Video sample",
  },
  "idea-to-3d-model": {
    ...reviewedSample("idea-to-3d-model", "One line becomes a textured 3D model: a teal-and-cream wind-up toy submarine with a brass periscope, portholes, a wind-up key and a striped tail. GLM writes the concept, Muse paints it, and TRELLIS.2 turns that one picture into a GLB that holds up from every side. The viewer shades it flatter than the concept, and the thin key and propeller blades go soft at some angles.", "Concept render and 3D turntable of a teal wind-up toy submarine"),
    preview: "https://media.nanoodle.com/mcp/examples/idea-to-3d-model.webp",
    title: "3D sample",
  },
  "mix-the-references": {
    ...reviewedSample("mix-the-references", "Four separate references become one picture: a paper-craft fox (image 1) wears a yellow knitted raincoat (image 2), holds one red paper lantern (image 3) and stands on a cardboard pier at dusk (image 4). FLUX.3 Klein Edit gets them in port order and the instruction names each image by number. Flaws in the saved run: the paper boats from the place reference mostly drop out and the coat comes out longer than its flat-lay reference.", "Paper-craft fox in a yellow knitted raincoat holding a red paper lantern on a cardboard pier"),
    preview: "https://media.nanoodle.com/mcp/examples/mix-the-references.webp",
    title: "Composite sample",
  },
  "character-sprites": {
    title: "Iron Verdict",
    play: "https://nanoodle.com/examples/iron-verdict/",
    preview: `${MEDIA_EXAMPLES}/iron-verdict.png`,
    alt: "Iron Verdict gameplay screenshot",
    skill: "https://github.com/nanoodlecom/noodle-skills/tree/main/skills/character-sprites",
    description: "A playable fighting game built with character-sprites. This graph generates a character reference and parts sheet; the local skill bakes animated sprites, and a coding agent adds combat, gravity and game rules.",
  },
};


export function workflowExample(name) {
  return Object.hasOwn(WORKFLOW_EXAMPLES, name) ? WORKFLOW_EXAMPLES[name] : null;
}
