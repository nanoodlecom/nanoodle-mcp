import { build } from "esbuild";
await build({
  entryPoints: { "near-wallet": "src/near-pay-browser.mjs", "near-site": "src/near-site-browser.mjs" },
  bundle: true, platform: "browser", target: "es2022", format: "esm", minify: true, outdir: "assets",
  banner: { js: "/*! Nanoodle browser assets. Wallet dependency licenses: /near-wallet.LICENSE.txt */" },
});
