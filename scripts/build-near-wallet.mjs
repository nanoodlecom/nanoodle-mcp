import { build } from "esbuild";
await build({
  entryPoints: { "near-wallet": "src/near-pay-browser.mjs" },
  bundle: true, platform: "browser", target: "es2022", format: "esm", minify: true, outdir: "assets",
  banner: { js: "/*! Includes NEAR Connect 0.12.0, MIT, HOT Labs. See /near-wallet.LICENSE.txt */" },
});
