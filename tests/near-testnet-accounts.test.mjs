/**
 * scripts/near-testnet-accounts.mjs offline: key generation and 0600 key
 * files, the exact request it sends to the account helper (as near-cli-rs
 * sends it), the on-chain confirmation, refusal handling with fallback
 * commands, --use-existing, --implicit, and the git-ignore guard. A local
 * stand-in plays the helper; the chain stand-in plays RPC. No network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeChain, throwawayNearKey } from "./fixtures/near-fake-chain.mjs";
import { parseNearToYocto } from "../src/near/amount.mjs";
import { loadNearSigner } from "../src/near/keys.mjs";
import { setupAccounts } from "../scripts/near-testnet-accounts.mjs";
import { FAUCET_URLS, generateNearKey, requestFaucetAccount, checkKeysDirIgnored } from "../scripts/near-testnet-lib.mjs";

const noSleep = async () => {};

/** A helper-service stand-in: records requests; `mode` decides the answer. */
function fakeHelper(chain, { mode = "ok", fundYocto = parseNearToYocto("10") } = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    const { newAccountId, newAccountPublicKey } = JSON.parse(init.body);
    if (mode === "429") return new Response("Too many requests", { status: 429 });
    if (mode === "down") throw new TypeError("fetch failed");
    if (mode === "false") return new Response(JSON.stringify({ status: { SuccessValue: "ZmFsc2U=" }, transaction_outcome: { id: "Fhash" } }), { status: 200 });
    if (mode === "second-only" && url === FAUCET_URLS[0]) return new Response("Bad Gateway", { status: 502 });
    chain.addAccount(newAccountId, fundYocto, newAccountPublicKey);
    return new Response(JSON.stringify({ final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { hash: "CreateTx1" }, transaction_outcome: { id: "CreateTx1" }, receipts_outcome: [] }), { status: 200 });
  };
  return { fetch, requests };
}

async function env() {
  const chain = createFakeChain();
  await chain.listen();
  const keysDir = join(await mkdtemp(join(tmpdir(), "near-accts-")), "keys");
  return { chain, keysDir };
}

const run = async (argv, deps) => {
  const lines = [];
  const r = await setupAccounts(argv, { print: (l) => lines.push(String(l)), sleep: noSleep, ...deps });
  return { ...r, out: lines.join("\n") };
};

test("creates both accounts through the helper with the near-cli-rs request shape; keys stay local in 0600 files", async () => {
  const { chain, keysDir } = await env();
  const helper = fakeHelper(chain);
  try {
    const r = await run(["--keys-dir", keysDir, "--rpc", chain.url], { fetch: helper.fetch });
    assert.equal(r.exitCode, 0, r.out);
    assert.match(r.out, /READY/);
    assert.equal(helper.requests.length, 2);
    for (const q of helper.requests) {
      assert.equal(q.url, "https://helper.nearprotocol.com/account");
      assert.equal(q.method, "POST");
      assert.equal(q.headers["content-type"], "application/json");
      assert.deepEqual(Object.keys(q.body).sort(), ["newAccountId", "newAccountPublicKey"]);
      assert.match(q.body.newAccountId, /^e2e-[mp]-[0-9a-f]{10}\.testnet$/);
      assert.match(q.body.newAccountPublicKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    }
    const cfg = JSON.parse(await readFile(join(keysDir, "accounts.json"), "utf8"));
    assert.equal(cfg.network, "testnet");
    assert.ok(!JSON.stringify(cfg).includes("private"), "accounts.json holds no key material");
    for (const role of ["merchant", "payer"]) {
      const { accountId, keyFile } = cfg[role];
      assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
      const signer = await loadNearSigner({ accountId, keyFile, env: {} }); // the format --near-key-file reads
      assert.equal(signer.publicKey, cfg[role].publicKey);
      const secret = JSON.parse(await readFile(keyFile, "utf8")).private_key;
      assert.ok(!r.out.includes(secret.slice(8)), "the private key is never printed");
      assert.ok(!JSON.stringify(helper.requests).includes(secret.slice(8)), "the private key is never sent");
    }
    assert.equal((await stat(keysDir)).mode & 0o777, 0o700);
    assert.match(r.out, /node scripts\/near-testnet-e2e\.mjs --mock-model/);

    // running again reports the existing setup instead of creating more
    const again = await run(["--keys-dir", keysDir, "--rpc", chain.url], { fetch: helper.fetch });
    assert.equal(again.exitCode, 0);
    assert.equal(helper.requests.length, 2);
    assert.match(again.out, /Accounts in .*accounts\.json/);
  } finally { await chain.close(); }
});

test("falls back to the docs.near.org helper when the near-cli-rs one fails", async () => {
  const { chain, keysDir } = await env();
  const helper = fakeHelper(chain, { mode: "second-only" });
  try {
    const r = await run(["--keys-dir", keysDir, "--rpc", chain.url], { fetch: helper.fetch });
    assert.equal(r.exitCode, 0, r.out);
    assert.deepEqual(helper.requests.map((q) => q.url), [FAUCET_URLS[0], FAUCET_URLS[1], FAUCET_URLS[0], FAUCET_URLS[1]]);
  } finally { await chain.close(); }
});

for (const mode of ["429", "down", "false"]) {
  test(`a refusing helper (${mode}) fails clearly, keeps the key, and prints the near-cli-rs fallbacks`, async () => {
    const { chain, keysDir } = await env();
    const helper = fakeHelper(chain, { mode });
    try {
      const r = await run(["--keys-dir", keysDir, "--rpc", chain.url, "--merchant", "my-merchant-1.testnet"], { fetch: helper.fetch });
      assert.equal(r.exitCode, 1, r.out);
      assert.match(r.out, /FAIL: could not create the merchant account my-merchant-1\.testnet/);
      const keyFile = join(keysDir, "my-merchant-1.testnet.json");
      assert.ok(existsSync(keyFile), "the key is kept");
      const pub = JSON.parse(await readFile(keyFile, "utf8")).public_key;
      assert.ok(r.out.includes(`near account create-account sponsor-by-faucet-service my-merchant-1.testnet use-manually-provided-public-key ${pub} network-config testnet create`));
      assert.match(r.out, /save-to-legacy-keychain/);
      assert.match(r.out, /--implicit/);
      assert.match(r.out, /--use-existing --merchant my-merchant-1\.testnet --merchant-key-file /);
      assert.ok(!existsSync(join(keysDir, "accounts.json")));
      if (mode === "429") assert.match(r.out, /HTTP 429/);

      // re-running with the same name reuses the same key (no new key, no lost key)
      const ok = fakeHelper(chain);
      const r2 = await run(["--keys-dir", keysDir, "--rpc", chain.url, "--merchant", "my-merchant-1.testnet"], { fetch: ok.fetch });
      assert.equal(r2.exitCode, 0, r2.out);
      assert.equal(ok.requests[0].body.newAccountPublicKey, pub);
    } finally { await chain.close(); }
  });
}

test("a name that is already taken is refused before any request", async () => {
  const { chain, keysDir } = await env();
  chain.addAccount("taken.testnet", 1n, (await throwawayNearKey()).publicKey);
  const helper = fakeHelper(chain);
  try {
    const r = await run(["--keys-dir", keysDir, "--rpc", chain.url, "--merchant", "taken.testnet"], { fetch: helper.fetch });
    assert.equal(r.exitCode, 1);
    assert.match(r.out, /taken\.testnet already exists and this key is not on it/);
    assert.equal(helper.requests.length, 0);
  } finally { await chain.close(); }
});

test("--dry-run writes keys and sends nothing", async () => {
  const { chain, keysDir } = await env();
  const helper = fakeHelper(chain);
  try {
    const r = await run(["--keys-dir", keysDir, "--rpc", chain.url, "--dry-run"], { fetch: helper.fetch });
    assert.equal(r.exitCode, 0, r.out);
    assert.equal(helper.requests.length, 0);
    assert.match(r.out, /would POST to https:\/\/helper\.nearprotocol\.com\/account: \{"newAccountId":"e2e-m-/);
  } finally { await chain.close(); }
});

test("--use-existing adopts near-cli files (including near-cli-rs files without account_id) and checks them on chain", async () => {
  const { chain, keysDir } = await env();
  const src = await mkdtemp(join(tmpdir(), "near-src-"));
  const mk = await throwawayNearKey(), pk = await throwawayNearKey();
  chain.addAccount("shop.testnet", parseNearToYocto("1"), mk.publicKey);
  chain.addAccount("wallet.testnet", parseNearToYocto("2"), pk.publicKey);
  // near-cli JS format (account_id present) and near-cli-rs legacy-keychain format (no account_id)
  await writeFile(join(src, "m.json"), JSON.stringify({ account_id: "shop.testnet", public_key: mk.publicKey, private_key: mk.secretKey }), { mode: 0o600 });
  await writeFile(join(src, "p.json"), JSON.stringify({ implicit_account_id: "ab", master_seed_phrase: "x", seed_phrase_hd_path: "m/44'/397'/0'", public_key: pk.publicKey, private_key: pk.secretKey }), { mode: 0o600 });
  try {
    const argv = ["--use-existing", "--keys-dir", keysDir, "--rpc", chain.url, "--merchant", "shop.testnet", "--merchant-key-file", join(src, "m.json"), "--payer", "wallet.testnet", "--payer-key-file", join(src, "p.json")];
    const r = await run(argv, {});
    assert.equal(r.exitCode, 0, r.out);
    const cfg = JSON.parse(await readFile(join(keysDir, "accounts.json"), "utf8"));
    assert.equal(cfg.merchant.keyFile, join(src, "m.json"), "a file that names its account is used in place");
    assert.equal(cfg.payer.keyFile, join(keysDir, "wallet.testnet.json"), "a near-cli-rs file is normalized");
    const norm = JSON.parse(await readFile(cfg.payer.keyFile, "utf8"));
    assert.deepEqual(Object.keys(norm).sort(), ["account_id", "private_key", "public_key"], "seed phrase fields are not copied");
    assert.equal((await stat(cfg.payer.keyFile)).mode & 0o777, 0o600);
    await loadNearSigner({ accountId: "wallet.testnet", keyFile: cfg.payer.keyFile, env: {} });
    assert.ok(!r.out.includes(pk.secretKey.slice(8)));

    // a key that is not on the account is refused with a clear message
    const other = await throwawayNearKey();
    await writeFile(join(src, "bad.json"), JSON.stringify({ account_id: "shop.testnet", public_key: other.publicKey, private_key: other.secretKey }), { mode: 0o600 });
    const bad = await run(["--use-existing", "--keys-dir", join(keysDir, "b"), "--rpc", chain.url, "--merchant", "shop.testnet", "--merchant-key-file", join(src, "bad.json"), "--payer", "wallet.testnet", "--payer-key-file", join(src, "p.json")], {});
    assert.equal(bad.exitCode, 1);
    assert.match(bad.out, /is NOT a key of this account/);
    assert.match(bad.out, /FAIL: a key above is not a full-access key/);

    // an under-funded account is adopted but reported as not ready (exit 3)
    chain.addAccount("poor.testnet", parseNearToYocto("0.01"), other.publicKey);
    await writeFile(join(src, "poor.json"), JSON.stringify({ account_id: "poor.testnet", public_key: other.publicKey, private_key: other.secretKey }), { mode: 0o600 });
    const poor = await run(["--use-existing", "--keys-dir", join(keysDir, "c"), "--rpc", chain.url, "--merchant", "shop.testnet", "--merchant-key-file", join(src, "m.json"), "--payer", "poor.testnet", "--payer-key-file", join(src, "poor.json")], {});
    assert.equal(poor.exitCode, 3, poor.out);
    assert.match(poor.out, /needs at least 0\.1 NEAR spendable/);
  } finally { await chain.close(); }
});

test("--implicit writes two implicit-account keys and reports funding on the next run", async () => {
  const { chain, keysDir } = await env();
  try {
    const r = await run(["--implicit", "--keys-dir", keysDir, "--rpc", chain.url], {});
    assert.equal(r.exitCode, 3, r.out);
    const cfg = JSON.parse(await readFile(join(keysDir, "accounts.json"), "utf8"));
    for (const role of ["merchant", "payer"]) {
      assert.match(cfg[role].accountId, /^[0-9a-f]{64}$/);
      await loadNearSigner({ accountId: cfg[role].accountId, keyFile: cfg[role].keyFile, env: {} });
    }
    // fund them (an implicit account appears with its key when it receives NEAR)
    chain.addAccount(cfg.merchant.accountId, parseNearToYocto("1"), cfg.merchant.publicKey);
    chain.addAccount(cfg.payer.accountId, parseNearToYocto("1"), cfg.payer.publicKey);
    const r2 = await run(["--keys-dir", keysDir, "--rpc", chain.url], {});
    assert.equal(r2.exitCode, 0, r2.out);
    assert.match(r2.out, /READY/);
  } finally { await chain.close(); }
});

test("refuses a keys directory inside a git work tree that is not ignored", async () => {
  const repo = await mkdtemp(join(tmpdir(), "near-git-"));
  const git = spawnSync("git", ["init", "-q", repo]);
  if (git.error || git.status !== 0) return; // no git on this machine: the guard has nothing to check
  assert.equal(checkKeysDirIgnored(join(repo, ".near-testnet")).ok, false);
  const r = await run(["--keys-dir", join(repo, ".near-testnet"), "--rpc", "http://127.0.0.1:9"], {});
  assert.equal(r.exitCode, 1);
  assert.match(r.out, /REFUSED: .* is not git-ignored/);
  assert.ok(!existsSync(join(repo, ".near-testnet")), "nothing written");
  await writeFile(join(repo, ".gitignore"), ".near-testnet/\n");
  assert.equal(checkKeysDirIgnored(join(repo, ".near-testnet")).ok, true);
  await mkdir(join(repo, "sub"));
  assert.equal(checkKeysDirIgnored(join(tmpdir(), "definitely-not-a-repo-xyz", "keys")).ok, true);
});

test("generateNearKey never exposes the secret when serialized or inspected", async () => {
  const k = generateNearKey();
  assert.ok(!JSON.stringify(k).includes(k.secret.slice(8)));
  const { inspect } = await import("node:util");
  assert.ok(!inspect(k).includes(k.secret.slice(8)));
  assert.match(k.implicitAccountId, /^[0-9a-f]{64}$/);
});

test("requestFaucetAccount maps transport errors and HTTP failures without throwing", async () => {
  const r1 = await requestFaucetAccount({ url: "https://x.invalid/account", accountId: "a.testnet", publicKey: "ed25519:x", fetch: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(r1.ok, false);
  assert.match(r1.detail, /request failed/);
  const r2 = await requestFaucetAccount({ url: "https://x.invalid/account", accountId: "a.testnet", publicKey: "ed25519:x", fetch: async () => new Response("nope", { status: 500 }) });
  assert.deepEqual([r2.ok, r2.status], [false, 500]);
  const r3 = await requestFaucetAccount({ url: "https://x.invalid/account", accountId: "a.testnet", publicKey: "ed25519:x", fetch: async () => new Response(JSON.stringify({ status: { Failure: { ActionError: {} } } }), { status: 200 }) });
  assert.equal(r3.ok, false);
  assert.match(r3.detail, /creation transaction failed/);
});
