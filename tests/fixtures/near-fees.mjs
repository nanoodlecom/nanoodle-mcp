// Synthetic protocol fees. All financial tests stay offline and use test keys.
export function nearProtocol({ chainId = "testnet", floor = "1000000000", feeGas = 100_000_000_000 } = {}) {
  const fee = () => ({ send_sir: feeGas, send_not_sir: feeGas, execution: feeGas });
  return { chain_id: chainId, protocol_version: 88, runtime_config: { min_gas_purchase_price: floor,
    storage_amount_per_byte: "10000000000000000000", transaction_costs: {
      pessimistic_gas_price_inflation_ratio: [1, 1], action_receipt_creation_config: fee(),
      action_creation_config: { transfer_cost: fee(), create_account_cost: fee(), add_key_cost: { full_access_cost: fee() },
        function_call_cost: fee(), function_call_cost_per_byte: { send_sir: 1000, send_not_sir: 1000, execution: 1000 } },
    } } };
}
