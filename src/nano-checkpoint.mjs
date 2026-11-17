import { NANO_GENESIS } from "./nano-read-pool.mjs";

/** Selected public-chain facts for a private operator handoff. This is telemetry,
 * not a durable journal or permission to start another account writer. */
export function selectNanoCheckpoint(value, account = null) {
  const fail = () => { throw Object.assign(Error("Nano checkpoint is unavailable or invalid"), { code: "NANO_CHECKPOINT_INVALID" }); };
  const head = value => {
    if (!value || typeof value.blockCount !== "string" || !/^[1-9]\d{0,38}$/.test(value.blockCount)
      || BigInt(value.blockCount) >= 2n ** 128n || !/^[A-F0-9]{64}$/.test(value.hash || "") || /^0+$/.test(value.hash)) fail();
    return { hash: value.hash, blockCount: value.blockCount };
  };
  // Wallet construction already validates the address checksum. Keep this
  // telemetry selector outside the optional GPL wallet implementation.
  if (value?.v !== 1 || value.networkGenesis !== NANO_GENESIS || !/^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(value.account || "")
    || account !== null && value.account !== account) fail();
  const current = head(value.head), confirmed = head(value.confirmed);
  if (BigInt(current.blockCount) < BigInt(confirmed.blockCount)
    || current.blockCount === confirmed.blockCount && current.hash !== confirmed.hash) fail();
  return { v: 1, networkGenesis: NANO_GENESIS, account: value.account, head: current, confirmed };
}
