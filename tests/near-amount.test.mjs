/**
 * NEAR amount math: exact BigInt yoctoNEAR, decimal parsing and display,
 * deposits with unique dust, and settlement at a locked rate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  YOCTO_PER_NEAR, DUST_STEP_YOCTO, MIN_REFUND_YOCTO,
  parseNearToYocto, formatYoctoAsNear, rateFromNearUsd, usdToYocto, depositYocto, settleYocto,
} from "../src/near/amount.mjs";
import { isNearAccountId, assertNearAccountId } from "../src/near/account.mjs";
import { NEAR_NETWORKS, explorerTxUrl, explorerAccountUrl } from "../src/near/explorer.mjs";

const RATE = rateFromNearUsd("3.64");

test("constants", () => {
  assert.equal(YOCTO_PER_NEAR, 10n ** 24n);
  assert.equal(DUST_STEP_YOCTO, 10n ** 18n);
  assert.equal(MIN_REFUND_YOCTO, 10n ** 19n);
});

test("parseNearToYocto / formatYoctoAsNear round trips", () => {
  assert.equal(parseNearToYocto("0.008379"), 8379000000000000000000n);
  assert.equal(parseNearToYocto("0"), 0n);
  assert.equal(parseNearToYocto("1"), YOCTO_PER_NEAR);
  assert.equal(parseNearToYocto(" 2.5 "), 25n * 10n ** 23n);
  assert.equal(parseNearToYocto("0.000000000000000000000001"), 1n);
  const all24 = "123.456789012345678901234567";
  assert.equal(formatYoctoAsNear(parseNearToYocto(all24)), all24);
  for (const s of ["0", "1", "0.008379", "0.003102197802197802197803", "1000000", "0.1"]) {
    assert.equal(formatYoctoAsNear(parseNearToYocto(s)), s);
  }
  assert.equal(formatYoctoAsNear(0n), "0");
  assert.equal(formatYoctoAsNear("8379000000000000000000"), "0.008379");
  assert.equal(formatYoctoAsNear(1n), "0.000000000000000000000001");
  assert.ok(!formatYoctoAsNear(10n ** 40n).includes("e"));
});

test("parseNearToYocto rejections", () => {
  for (const bad of ["", "abc", "-1", "1e3", "1.", ".5", "0.0000000000000000000000001", "1,5", "0x10", "NaN", "1 2"]) {
    assert.throws(() => parseNearToYocto(bad), { name: "NearError", code: "BAD_AMOUNT" }, bad);
  }
  for (const bad of [1, 1n, null, undefined, {}]) {
    assert.throws(() => parseNearToYocto(bad), { code: "BAD_AMOUNT" });
  }
});

test("formatYoctoAsNear rounds half-up for display only", () => {
  assert.equal(formatYoctoAsNear(3171586813186813186813n, { maxDecimals: 6 }), "0.003172");
  assert.equal(formatYoctoAsNear(1499999999999999999n, { maxDecimals: 6 }), "0.000001");
  assert.equal(formatYoctoAsNear(500000000000000000n, { maxDecimals: 6 }), "0.000001");
  assert.equal(formatYoctoAsNear(499999999999999999n, { maxDecimals: 6 }), "0");
  assert.equal(formatYoctoAsNear(999999500000000000000000n, { maxDecimals: 6 }), "1");
  assert.equal(formatYoctoAsNear(15n * 10n ** 23n, { maxDecimals: 0 }), "2");
  assert.throws(() => formatYoctoAsNear(-1n), { code: "BAD_AMOUNT" });
  assert.throws(() => formatYoctoAsNear(1.5), { code: "BAD_AMOUNT" });
});

test("rateFromNearUsd", () => {
  assert.deepEqual(RATE, { usdNano: 3_640_000_000n, yocto: 10n ** 24n, nearUsd: "3.64" });
  assert.equal(rateFromNearUsd(3.64).usdNano, 3_640_000_000n);
  for (const bad of ["0", 0, "-1", "abc", "", null, NaN, Infinity]) {
    assert.throws(() => rateFromNearUsd(bad), { code: "BAD_RATE" }, String(bad));
  }
});

test("usdToYocto floor/ceil", () => {
  // $0.03 at $3.64 = 0.008241758241758241758241758... NEAR
  assert.equal(usdToYocto("0.03", RATE, "floor"), 8241758241758241758241n);
  assert.equal(usdToYocto("0.03", RATE, "ceil"), 8241758241758241758242n);
  // exact division: floor == ceil
  assert.equal(usdToYocto("3.64", RATE, "floor"), YOCTO_PER_NEAR);
  assert.equal(usdToYocto("3.64", RATE, "ceil"), YOCTO_PER_NEAR);
  assert.equal(usdToYocto(0, RATE, "ceil"), 0n);
  assert.throws(() => usdToYocto("1", RATE, "round"), TypeError);
  assert.throws(() => usdToYocto("x", RATE, "ceil"), { code: "BAD_AMOUNT" });
  assert.throws(() => usdToYocto("1", { usdNano: 0n, yocto: 1n }, "ceil"), { code: "BAD_RATE" });
});

test("depositYocto: worked example and dust", () => {
  const base = 8242000000000000000000n;
  assert.equal(depositYocto("0.03", RATE, () => false, () => 137), 8379000000000000000000n);
  let calls = 0;
  for (let i = 0; i < 200; i++) {
    const d = depositYocto("0.03", RATE, () => false);
    assert.equal(d % DUST_STEP_YOCTO, 0n);
    const k = (d - base) / DUST_STEP_YOCTO;
    assert.ok(k >= 1n && k <= 999n, `dust ${k}`);
    calls++;
  }
  assert.equal(calls, 200);
});

test("depositYocto avoids taken amounts, never leaves 1-999 dust steps, then gives up", () => {
  const base = 8242000000000000000000n;
  const seq = [5, 5, 5, 7];
  let i = 0;
  const taken = new Set([base + 5n * DUST_STEP_YOCTO]);
  const d = depositYocto("0.03", RATE, (a) => taken.has(a), () => seq[i++]);
  assert.equal(d, base + 7n * DUST_STEP_YOCTO);

  // 200 random misses: a scan finds the one free step; dust stays below 0.001 NEAR.
  const free = base + 998n * DUST_STEP_YOCTO;
  let calls = 0;
  const scanned = depositYocto("0.03", RATE, (a) => a !== free, () => { calls++; return 1; });
  assert.equal(scanned, free);
  assert.equal(calls, 200);

  let tries = 0;
  assert.throws(() => depositYocto("0.03", RATE, () => true, () => { tries++; return 1; }), { code: "NO_UNIQUE_AMOUNT" });
  assert.equal(tries, 200);
});

test("settleYocto worked example (exact)", () => {
  const s = settleYocto({ depositYocto: 8379000000000000000000n, costUsd: 0.00941, rate: RATE });
  assert.deepEqual(s, {
    known: true,
    costYocto: 2585164835164835164836n,
    feeYocto: 517032967032967032967n,
    chargedYocto: 3102197802197802197803n,
    refundYocto: 5276802197802197802197n,
  });
  assert.equal(formatYoctoAsNear(s.chargedYocto), "0.003102197802197802197803");
  assert.equal(formatYoctoAsNear(s.refundYocto), "0.005276802197802197802197");
  // the same with a string cost
  assert.deepEqual(settleYocto({ depositYocto: 8379000000000000000000n, costUsd: "0.00941", rate: RATE }), s);
});

test("settleYocto: unknown cost refunds everything", () => {
  for (const costUsd of [null, undefined, "", "abc", -1, NaN, false, []]) {
    assert.deepEqual(settleYocto({ depositYocto: 5n * 10n ** 21n, costUsd, rate: RATE }), {
      known: false, costYocto: 0n, feeYocto: 0n, chargedYocto: 0n, refundYocto: 5n * 10n ** 21n,
    });
  }
});

test("settleYocto: zero cost is known and refunds everything", () => {
  const s = settleYocto({ depositYocto: 5n * 10n ** 21n, costUsd: 0, rate: RATE });
  assert.equal(s.known, true);
  assert.equal(s.chargedYocto, 0n);
  assert.equal(s.refundYocto, 5n * 10n ** 21n);
});

test("settleYocto: cost above the deposit charges the deposit", () => {
  const s = settleYocto({ depositYocto: 8379000000000000000000n, costUsd: "1.00", rate: RATE });
  assert.equal(s.chargedYocto, 8379000000000000000000n);
  assert.equal(s.refundYocto, 0n);
  assert.ok(s.costYocto + s.feeYocto > s.chargedYocto);
});

test("settleYocto: a refund below the minimum is folded into the charge", () => {
  const deposit = 10n ** 21n;
  // cost such that refund lands below 1e19: cost+fee ~ deposit - 5e18
  const rate = { usdNano: 1_000_000_000n, yocto: YOCTO_PER_NEAR }; // 1 NEAR = $1
  // cost $0.000829 = 829e18 yocto, fee 165.8e18, charged 994.8e18, refund 5.2e18 (< 1e19)
  const s = settleYocto({ depositYocto: deposit, costUsd: "0.000829", rate });
  assert.equal(s.refundYocto, 0n);
  assert.equal(s.chargedYocto, deposit);
  // with a lower minimum it is refunded
  const t = settleYocto({ depositYocto: deposit, costUsd: "0.000829", rate, minRefundYocto: 1n });
  assert.equal(t.refundYocto, 5_200_000_000_000_000_000n);
  assert.equal(t.refundYocto, deposit - (829n * 10n ** 18n + 1658n * 10n ** 17n));
  assert.equal(t.chargedYocto + t.refundYocto, deposit);
});

test("settleYocto rejects a non-bigint deposit", () => {
  assert.throws(() => settleYocto({ depositYocto: 1000, costUsd: 0, rate: RATE }), { code: "BAD_AMOUNT" });
});

test("account ids", () => {
  for (const ok of ["payer.testnet", "merchant.testnet", "a1", "test.near", "web3-central_x.near", "0".repeat(64), "abcdef0123456789".repeat(4)]) {
    assert.equal(isNearAccountId(ok), true, ok);
  }
  for (const bad of ["a", "", "Payer.testnet", "a..b", ".a", "a.", "a b", "a".repeat(65), null, 1, "a@b"]) {
    assert.equal(isNearAccountId(bad), false, String(bad));
  }
  assert.equal(assertNearAccountId("payer.testnet"), "payer.testnet");
  assert.throws(() => assertNearAccountId("NO"), { code: "BAD_ACCOUNT" });
});

test("explorer links", () => {
  assert.equal(NEAR_NETWORKS.testnet.rpcUrl, "https://test.rpc.fastnear.com");
  assert.equal(NEAR_NETWORKS.mainnet.rpcUrl, "https://free.rpc.fastnear.com");
  assert.equal(explorerTxUrl("testnet", "HGcec6L7AjpSUAUcGe5EJ2WduQeUe7pGwwdzBv7WaTs1"), "https://testnet.nearblocks.io/txns/HGcec6L7AjpSUAUcGe5EJ2WduQeUe7pGwwdzBv7WaTs1");
  assert.equal(explorerAccountUrl("mainnet", "merchant.near"), "https://nearblocks.io/address/merchant.near");
  assert.throws(() => explorerTxUrl("devnet", "x"), TypeError);
  assert.ok(Object.isFrozen(NEAR_NETWORKS));
});
