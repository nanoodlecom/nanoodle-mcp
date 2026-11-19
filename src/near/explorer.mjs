/** Per-network defaults and explorer links. */

export const NEAR_NETWORKS = Object.freeze({
  // rpcUrl is the first choice; rpcUrls is the default failover order (see createNearRpcPool).
  testnet: Object.freeze({
    rpcUrl: "https://test.rpc.fastnear.com",
    rpcUrls: Object.freeze(["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"]),
    explorer: "https://testnet.nearblocks.io",
  }),
  mainnet: Object.freeze({
    rpcUrl: "https://free.rpc.fastnear.com",
    rpcUrls: Object.freeze(["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"]),
    explorer: "https://nearblocks.io",
  }),
});

function network(name) {
  const n = Object.hasOwn(NEAR_NETWORKS, name) ? NEAR_NETWORKS[name] : null;
  if (!n) throw new TypeError(`unknown NEAR network: ${JSON.stringify(name)}`);
  return n;
}

export function explorerTxUrl(net, txHash) {
  return `${network(net).explorer}/txns/${encodeURIComponent(txHash)}`;
}

export function explorerAccountUrl(net, accountId) {
  return `${network(net).explorer}/address/${encodeURIComponent(accountId)}`;
}
