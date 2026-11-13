#!/usr/bin/env node
// Run on the Nanoodle host as its service user. Adoption links are private
// operator capabilities; never put this command's output in a public page/log.
import { resolve } from "node:path";
import { createHostedWorkflows } from "../src/hosted-workflows.mjs";
import { createHostedPublisher } from "../src/market/hosted.mjs";
const [command, dir, id] = process.argv.slice(2);
try {
  if (!dir || !["list", "register", "adoption", "publish"].includes(command)) throw new Error("Usage: node scripts/hosted-workflows.mjs list|register|adoption|publish /absolute/hosted-workflows-dir [wf_id]");
  const creators = createHostedWorkflows({ dir: resolve(dir), publicBase: process.env.NEAR_PUBLIC_URL || "https://near.nanoodle.com", baseUrl: process.env.NANOGPT_BASE_URL });
  if (command === "list") console.log(JSON.stringify(creators.all().map(record => creators.publicView(record.id)), null, 2));
  else {
    const publisher = createHostedPublisher({ creators, ownerAccountId: process.env.MARKET_HOSTED_OWNER_ACCOUNT_ID });
    console.log(JSON.stringify(await publisher[command](id), null, 2));
  }
} catch (e) { console.error(e.message); process.exitCode = 1; }
