// Public mainnet genesis and zero-seed test-vector accounts, never real keys.
export const NANO_GENESIS_HASH = "991CF190094C00F0B68E2E5F75F6BEE95A2E0BD93CEAA4A6734DB9F19B728948";
const genesisAccount = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
export const NANO_GENESIS_REPLY = { confirmed: "true", contents: { type: "open", account: genesisAccount, representative: genesisAccount,
  source: "E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA" } };
export function nanoAccountInfo({ frontier = "B".repeat(64), balance = "100", representative = genesisAccount, height = 10,
  pending = "0", confirmedHeight = height, confirmedFrontier = frontier, confirmedBalance = balance } = {}) {
  return { frontier, balance: String(balance), representative, block_count: String(height), confirmed_height: String(confirmedHeight),
    confirmed_frontier: confirmedFrontier, confirmed_balance: String(confirmedBalance), confirmed_representative: representative, confirmed_receivable: String(pending), receivable: String(pending) };
}
