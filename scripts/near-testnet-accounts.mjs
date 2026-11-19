#!/usr/bin/env node
/**
 * Create (or adopt) the two throwaway NEAR testnet accounts that
 * scripts/near-testnet-e2e.mjs needs: a merchant (receives payments, signs
 * refunds) and a payer (the agent's wallet).
 *
 *   node scripts/near-testnet-accounts.mjs                  create both through the testnet helper service
 *   node scripts/near-testnet-accounts.mjs --use-existing \
 *        --merchant <id> --merchant-key-file <path> --payer <id> --payer-key-file <path>
 *   node scripts/near-testnet-accounts.mjs --implicit       no helper service: two implicit accounts to fund yourself
 *   node scripts/near-testnet-accounts.mjs                  (again) report the accounts in accounts.json
 *
 * Options: --keys-dir <dir> (default .near-testnet/ in the repo; it must be
 * git-ignored or outside any git work tree), --merchant/--payer <name>.testnet
 * to choose names when creating, --faucet-url <url> to use one helper only,
 * --rpc <url>, --dry-run (generate and write keys, print the request it would
 * send, send nothing).
 *
 * Keys: ed25519 key pairs are generated locally with node:crypto and written
 * as near-cli credential files (<keys-dir>/<account>.json, mode 0600, the
 * format --near-key-file reads) BEFORE any request, so a key is never lost.
 * Only public keys are sent or printed. <keys-dir>/accounts.json lists the
 * account ids and key-file paths (no key material); the e2e script reads it.
 *
 * Account creation, from primary sources (read, not called, when this was written):
 *  - near-cli-rs src/config/mod.rs sets `faucet_url` for testnet to
 *    https://helper.nearprotocol.com/account;
 *    src/commands/account/create_account/sponsor_by_faucet_service/mod.rs
 *    POSTs JSON {"newAccountId", "newAccountPublicKey"} to it, treats HTTP
 *    >= 400 as failure, and reads a 2xx body as an RPC transaction response
 *    (SuccessValue of base64 "false" = not created).
 *  - docs.near.org (snippets/faucet.jsx) POSTs the same body to
 *    https://helper.testnet.near.org/account; the account it creates there
 *    can then send 5 NEAR, so a new account is funded with more than that.
 * The helper names accounts directly under `testnet` (<name>.testnet). Whether
 * the service answers, how much it funds and whether it rate-limits are only
 * known on a real run: this script confirms the outcome itself by reading the
 * new access key and balance from RPC, whatever the service answered.
 *
 * Exit codes: 0 ready, 1 failed (message and fallback commands printed),
 * 2 bad usage, 3 accounts exist but are not funded enough yet.
 */
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ACCOUNTS_FILE, DEFAULT_KEYS_DIR, FAUCET_URLS, MIN_MERCHANT_YOCTO, MIN_PAYER_YOCTO, NETWORK,
  absPath, adoptKeyFile, checkKeysDirIgnored, explorerAccountUrl, fallbackCommands, formatYoctoAsNear,
  generateNearKey, isNearAccountId, keyFileModeWarning, parseArgs, publicKeyOfKeyFile, readAccountsConfig,
  requestFaucetAccount, rpcFor, viewAccessKey, viewAccount, writeAccountsConfig, writeKeyFile,
} from "./near-testnet-lib.mjs";

const USAGE = `usage:
  node scripts/near-testnet-accounts.mjs [--keys-dir dir] [--merchant name.testnet] [--payer name.testnet] [--faucet-url url] [--rpc url] [--dry-run]
  node scripts/near-testnet-accounts.mjs --use-existing --merchant <id> --merchant-key-file <path> --payer <id> --payer-key-file <path> [--keys-dir dir] [--rpc url]
  node scripts/near-testnet-accounts.mjs --implicit [--keys-dir dir] [--rpc url]`;

const TOP_LEVEL_TESTNET = /^[a-z0-9]+(?:[_-][a-z0-9]+)*\.testnet$/;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Inspect one account: exists, the key is a full-access key, spendable balance.
 * Returns { ok, exists, keyOk, available, line }.
 */
async function inspect(rpc, role, accountId, publicKey, minYocto) {
  const acct = await viewAccount(rpc, accountId);
  if (!acct) return { ok: false, exists: false, keyOk: false, available: 0n, line: `${role} ${accountId}: does not exist on testnet yet` };
  const key = await viewAccessKey(rpc, accountId, publicKey);
  const keyOk = !!key && key.permission === "FullAccess";
  const funded = acct.available >= minYocto;
  const line = `${role} ${accountId}: balance ${formatYoctoAsNear(acct.amount)} NEAR (spendable ≈${formatYoctoAsNear(acct.available)}), ` +
    `key ${publicKey} ${key ? (keyOk ? "is a full-access key" : `has permission ${JSON.stringify(key.permission)}, not FullAccess`) : "is NOT a key of this account"}` +
    `${funded ? "" : `; needs at least ${formatYoctoAsNear(minYocto)} NEAR spendable`}`;
  return { ok: keyOk && funded, exists: true, keyOk, available: acct.available, line };
}

async function report(rpc, config, print) {
  const m = await inspect(rpc, "merchant", config.merchant.accountId, config.merchant.publicKey ?? (await publicKeyOfKeyFile(config.merchant.keyFile)).publicKey, MIN_MERCHANT_YOCTO);
  const p = await inspect(rpc, "payer", config.payer.accountId, config.payer.publicKey ?? (await publicKeyOfKeyFile(config.payer.keyFile)).publicKey, MIN_PAYER_YOCTO);
  for (const [r, x] of [["merchant", m], ["payer", p]]) {
    print(`  ${x.ok ? "OK  " : "NOT READY"} ${x.line}`);
    print(`       key file ${config[r].keyFile}`);
    print(`       ${explorerAccountUrl(NETWORK, config[r].accountId)}`);
    const warn = keyFileModeWarning(config[r].keyFile);
    if (warn) print(`  WARNING ${warn}`);
  }
  return { ready: m.ok && p.ok, keysOk: m.keyOk && p.keyOk, merchant: m, payer: p };
}

function nextSteps(print, accountsPath) {
  print("\nNext:");
  print(`  node scripts/near-testnet-e2e.mjs --dry-run --mock-model${accountsPath ? ` --accounts ${accountsPath}` : ""}   # every check that moves no funds`);
  print(`  node scripts/near-testnet-e2e.mjs --mock-model${accountsPath ? ` --accounts ${accountsPath}` : ""}             # real testnet payment + refund, model stand-in`);
  print(`  node scripts/near-testnet-e2e.mjs${accountsPath ? ` --accounts ${accountsPath}` : ""}                          # the same with one real NanoGPT text call`);
}

/** Create one named account through the helper; the key file is written first. */
async function createNamed({ rpc, role, accountId, keysDir, faucetUrls, fetch, sleep, dryRun, print }) {
  const keyFile = join(keysDir, `${accountId}.json`);
  let publicKey;
  if (existsSync(keyFile)) {
    const k = await publicKeyOfKeyFile(keyFile);
    if (k.accountId !== accountId) throw new Error(`${keyFile} is for ${k.accountId}, not ${accountId}`);
    publicKey = k.publicKey;
    print(`  ${role}: reusing the key in ${keyFile} (${publicKey})`);
  } else {
    const key = generateNearKey();
    await writeKeyFile(keyFile, accountId, key);
    publicKey = key.publicKey;
    print(`  ${role}: generated key ${publicKey}, written to ${keyFile} (mode 0600)`);
  }

  const already = await viewAccount(rpc, accountId);
  if (already) {
    const ak = await viewAccessKey(rpc, accountId, publicKey);
    if (ak && ak.permission === "FullAccess") {
      print(`  ${role}: ${accountId} already exists with this key; nothing to create`);
      return { ok: true, accountId, keyFile, publicKey };
    }
    return { ok: false, accountId, keyFile, publicKey, attempts: [], why: `${accountId} already exists and this key is not on it (the name is taken); choose another name with --${role}` };
  }

  if (dryRun) {
    print(`  ${role}: --dry-run, would POST to ${faucetUrls[0]}: ${JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey })}`);
    return { ok: false, dry: true, accountId, keyFile, publicKey, attempts: [] };
  }

  const attempts = [];
  for (const url of faucetUrls) {
    print(`  ${role}: asking ${url} to create ${accountId} …`);
    const r = await requestFaucetAccount({ url, accountId, publicKey, fetch });
    attempts.push({ url, ...r });
    print(`  ${role}: helper ${r.ok ? "accepted" : "refused"} (${r.detail})${r.txHash ? ` tx ${r.txHash}` : ""}`);
    // Whatever it answered, the chain decides: poll for the account and the key.
    for (let i = 0; i < (r.ok ? 10 : 3); i++) {
      const ak = await viewAccessKey(rpc, accountId, publicKey);
      if (ak && ak.permission === "FullAccess") {
        print(`  ${role}: ${accountId} exists on testnet with this full-access key`);
        return { ok: true, accountId, keyFile, publicKey, attempts };
      }
      if (await viewAccount(rpc, accountId)) {
        return { ok: false, accountId, keyFile, publicKey, attempts, why: `${accountId} now exists but without this key (someone else took the name); choose another name with --${role}` };
      }
      await sleep(3_000);
    }
  }
  return { ok: false, accountId, keyFile, publicKey, attempts, why: "no helper endpoint created the account" };
}

/**
 * The whole command. Returns { exitCode, config }. `print` gets every output line;
 * `fetch` is used for the helper service, `rpcFetch` for NEAR RPC (tests inject both).
 */
export async function setupAccounts(argv, { print = console.log, fetch = globalThis.fetch, rpcFetch, sleep = defaultSleep } = {}) {
  let opts;
  try {
    opts = parseArgs(argv, ["use-existing", "implicit", "dry-run", "help"]);
  } catch (e) {
    print(e.message); print(USAGE); return { exitCode: 2 };
  }
  if (opts.help) { print(USAGE); return { exitCode: 0 }; }
  if (opts.network && opts.network !== NETWORK) { print("this tool is testnet-only"); return { exitCode: 2 }; }
  const keysDir = absPath(opts["keys-dir"]) || DEFAULT_KEYS_DIR;
  const accountsPath = join(keysDir, ACCOUNTS_FILE);
  const rpcUrl = opts.rpc || process.env.NEAR_RPC_URL || undefined;
  const rpc = rpcFor(rpcUrl, rpcFetch);

  const ign = checkKeysDirIgnored(keysDir);
  if (!ign.ok) { print(`REFUSED: ${ign.reason}`); return { exitCode: 1 }; }

  let st;
  try { st = await rpc.status(); } catch (e) {
    print(`FAIL: cannot reach the NEAR RPC ${rpc.url} (${e.code}: ${e.message}). Check your connection or pass --rpc.`);
    return { exitCode: 1 };
  }
  if (st.chain_id !== NETWORK) { print(`FAIL: the RPC ${rpc.url} is on "${st.chain_id}", not testnet. Pass a testnet --rpc.`); return { exitCode: 1 }; }

  const modes = [opts["use-existing"], opts.implicit].filter(Boolean).length;
  if (modes > 1) { print("pick one of --use-existing and --implicit"); return { exitCode: 2 }; }

  // ---- adopt existing accounts ----
  if (opts["use-existing"]) {
    for (const k of ["merchant", "merchant-key-file", "payer", "payer-key-file"]) {
      if (!opts[k]) { print(`--use-existing needs --${k}`); print(USAGE); return { exitCode: 2 }; }
    }
    if (!isNearAccountId(opts.merchant) || !isNearAccountId(opts.payer)) { print("--merchant and --payer must be NEAR account ids"); return { exitCode: 2 }; }
    if (opts.merchant === opts.payer) { print("the merchant and the payer must be two different accounts"); return { exitCode: 2 }; }
    const config = { v: 1, network: NETWORK, createdAt: new Date().toISOString(), how: "use-existing" };
    for (const role of ["merchant", "payer"]) {
      try {
        const a = await adoptKeyFile(absPath(opts[`${role}-key-file`]), opts[role], join(keysDir, `${opts[role]}.json`));
        config[role] = { accountId: opts[role], keyFile: a.keyFile, publicKey: a.publicKey };
        print(`  ${role}: ${opts[role]} key ${a.publicKey}${a.copied ? ` (copied to ${a.keyFile} with account_id, mode 0600, because the source has no account_id)` : ` (${a.keyFile})`}`);
      } catch (e) {
        print(`FAIL: ${role} key file: ${e.message}`);
        return { exitCode: 1 };
      }
    }
    print("\nChecking both accounts on testnet:");
    const r = await report(rpc, config, print);
    if (!r.keysOk) {
      print("\nFAIL: a key above is not a full-access key of its account on testnet. Check the account id, the key file, and that the account is on testnet.");
      return { exitCode: 1, config };
    }
    const written = await writeAccountsConfig(keysDir, config);
    print(`\nwrote ${written}`);
    if (!r.ready) { print("Accounts adopted, but not funded enough yet: top them up and run this again."); return { exitCode: 3, config }; }
    print("READY");
    nextSteps(print, keysDir === DEFAULT_KEYS_DIR ? null : accountsPath);
    return { exitCode: 0, config };
  }

  // ---- report an existing setup ----
  if (existsSync(accountsPath) && !opts.merchant && !opts.payer) {
    let config;
    try { config = await readAccountsConfig(accountsPath); } catch (e) { print(`FAIL: ${e.message}`); return { exitCode: 1 }; }
    print(`Accounts in ${accountsPath} (${config.how || "created"} ${config.createdAt || ""}):`);
    const r = await report(rpc, config, print);
    if (r.ready) { print("READY"); nextSteps(print, keysDir === DEFAULT_KEYS_DIR ? null : accountsPath); return { exitCode: 0, config }; }
    if (config.how === "implicit") {
      print("\nNot ready. Fund these implicit accounts (any funded testnet wallet, or https://near-faucet.io/), then run this again:");
      print(`  merchant ${config.merchant.accountId}: at least ${formatYoctoAsNear(MIN_MERCHANT_YOCTO)} NEAR`);
      print(`  payer    ${config.payer.accountId}: at least ${formatYoctoAsNear(MIN_PAYER_YOCTO)} NEAR`);
    } else {
      print("\nNot ready: see the lines above. To start over, move the keys directory away and run this again.");
    }
    return { exitCode: 3, config };
  }

  // ---- implicit accounts: no helper service at all ----
  if (opts.implicit) {
    if (existsSync(accountsPath)) { print(`${accountsPath} already exists; move the keys directory away to start over`); return { exitCode: 1 }; }
    const config = { v: 1, network: NETWORK, createdAt: new Date().toISOString(), how: "implicit" };
    for (const role of ["merchant", "payer"]) {
      const key = generateNearKey();
      const accountId = key.implicitAccountId;
      const keyFile = join(keysDir, `${accountId}.json`);
      await writeKeyFile(keyFile, accountId, key);
      config[role] = { accountId, keyFile, publicKey: key.publicKey };
      print(`  ${role}: implicit account ${accountId}`);
      print(`       key ${key.publicKey} written to ${keyFile} (mode 0600)`);
    }
    const written = await writeAccountsConfig(keysDir, config);
    print(`\nwrote ${written}`);
    print("\nAn implicit account comes into existence when it first receives NEAR. Fund them now:");
    print(`  merchant ${config.merchant.accountId}: at least ${formatYoctoAsNear(MIN_MERCHANT_YOCTO)} NEAR`);
    print(`  payer    ${config.payer.accountId}: at least ${formatYoctoAsNear(MIN_PAYER_YOCTO)} NEAR`);
    print("  from any funded testnet wallet, e.g. with near-cli-rs:");
    print(`  near tokens <your-funded.testnet> send-near ${config.payer.accountId} '0.5 NEAR' network-config testnet sign-with-keychain send`);
    print(`  near tokens <your-funded.testnet> send-near ${config.merchant.accountId} '0.1 NEAR' network-config testnet sign-with-keychain send`);
    print("  or paste each id into the web faucet at https://near-faucet.io/");
    print("Then run: node scripts/near-testnet-accounts.mjs" + (keysDir === DEFAULT_KEYS_DIR ? "" : ` --keys-dir ${keysDir}`));
    return { exitCode: 3, config };
  }

  // ---- create two named accounts through the helper service ----
  if (existsSync(accountsPath)) { print(`${accountsPath} already exists; move the keys directory away (or pass another --keys-dir) to create new accounts`); return { exitCode: 1 }; }
  const tag = () => randomBytes(5).toString("hex");
  const names = { merchant: opts.merchant || `e2e-m-${tag()}.testnet`, payer: opts.payer || `e2e-p-${tag()}.testnet` };
  for (const role of ["merchant", "payer"]) {
    if (!TOP_LEVEL_TESTNET.test(names[role])) { print(`--${role} must be a name directly under testnet, like abc-123.testnet (got ${names[role]})`); return { exitCode: 2 }; }
  }
  if (names.merchant === names.payer) { print("the merchant and the payer must be two different accounts"); return { exitCode: 2 }; }
  const faucetUrls = opts["faucet-url"] ? [opts["faucet-url"]] : [...FAUCET_URLS];
  print(`Creating two testnet accounts through the account helper (${faucetUrls.join(", then ")}).`);
  print(`Keys are generated here and stay in ${keysDir}; only public keys are sent.\n`);

  const done = {};
  for (const role of ["merchant", "payer"]) {
    const r = await createNamed({ rpc, role, accountId: names[role], keysDir, faucetUrls, fetch, sleep, dryRun: !!opts["dry-run"], print });
    done[role] = r;
    if (r.dry) continue;
    if (!r.ok) {
      print(`\nFAIL: could not create the ${role} account ${r.accountId}: ${r.why}.`);
      for (const a of r.attempts || []) print(`  ${a.url}: ${a.detail}`);
      print(`The key for it is kept in ${r.keyFile}; nothing secret was sent.`);
      print("\nWhat this means: the testnet account helper refused or is unavailable (it is a free public service; it can be down, " +
        "rate-limited, or reject the name). Fallbacks, verified against near-cli-rs source:");
      for (const l of fallbackCommands({ accountId: r.accountId, publicKey: r.publicKey })) print("  " + l);
      print("\nAfter fallback A, adopt the accounts with:");
      const other = role === "merchant" ? "payer" : "merchant";
      print(`  node scripts/near-testnet-accounts.mjs --use-existing --${role} ${r.accountId} --${role}-key-file ${r.keyFile} ` +
        `--${other} ${done[other]?.ok ? done[other].accountId : "<id>"} --${other}-key-file ${done[other]?.ok ? done[other].keyFile : "<path>"}`);
      return { exitCode: 1 };
    }
  }
  if (opts["dry-run"]) {
    print("\n--dry-run: keys written, nothing sent, no accounts.json written.");
    return { exitCode: 0 };
  }
  const config = { v: 1, network: NETWORK, createdAt: new Date().toISOString(), how: "helper" };
  for (const role of ["merchant", "payer"]) config[role] = { accountId: done[role].accountId, keyFile: done[role].keyFile, publicKey: done[role].publicKey };
  const written = await writeAccountsConfig(keysDir, config);
  print(`\nwrote ${written}\n\nChecking both accounts on testnet:`);
  const r = await report(rpc, config, print);
  if (!r.ready) {
    print("\nThe accounts exist but are not funded enough (the helper's funding amount is not documented). " +
      "Send each some testnet NEAR from a funded wallet, then run this again.");
    return { exitCode: 3, config };
  }
  print("READY");
  nextSteps(print, keysDir === DEFAULT_KEYS_DIR ? null : accountsPath);
  return { exitCode: 0, config };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  setupAccounts(process.argv.slice(2)).then(
    ({ exitCode }) => process.exit(exitCode),
    (e) => { console.error(`FAIL: ${e?.message || e}`); process.exit(1); },
  );
}
