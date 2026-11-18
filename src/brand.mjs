export const NANOODLE_BRAND = "/brand/nanoodle-v1.0.0";
export const NANO_BRAND_HEAD =
  `<link rel="stylesheet" href="${NANOODLE_BRAND}/tokens/tokens.css"><link rel="stylesheet" href="${NANOODLE_BRAND}/fonts/fonts.css">`;
export const NANO_WORDMARK = `<img class="product-wordmark" src="${NANOODLE_BRAND}/assets/wordmark-gradient.svg" alt="nanoodle">`;
export const NANO_SURFACE_CSS = `
  :root {
    color-scheme:dark;
    --fg:var(--nano-color-ink); --bg:var(--nano-color-canvas); --muted:var(--nano-color-muted);
    --card:var(--nano-color-panel); --card2:var(--nano-color-raised); --edge:var(--nano-color-line);
    --accent:var(--nano-color-accent); --accent-ink:var(--nano-color-accent-ink);
    --ok:var(--nano-color-success);
  }
  body{font-family:var(--nano-font-body)}
  h1,h2{font-family:var(--nano-font-display);font-weight:400}
  code,pre{font-family:var(--nano-font-mono)}
  a{color:var(--accent-ink)}
  a:hover{color:var(--fg)}
  :focus-visible{outline:var(--nano-control-focus-width) solid var(--accent-ink);outline-offset:3px}
`;
export const NANO_PORT_CSS = `
  .chip.k-text,.chip.k-llm{--port:var(--nano-color-text-port)}
  .chip.k-image{--port:var(--nano-color-image-port)}
  .chip.k-video{--port:var(--nano-color-video-port)}
  .chip.k-audio{--port:var(--nano-color-audio-port)}
  .chip.k-model3d{--port:var(--nano-color-model3d-port)}
  .chip[class*="k-"]{background:color-mix(in srgb,var(--port,var(--muted)) 14%,var(--card));color:var(--port,var(--muted))}
`;
