// Gas pricing for the live tests' legacy and EIP-2930 transactions. Those carry one `gasPrice`
// with no fee cap above it, so a price at the node's current `eth_gasPrice` is stranded as soon as
// the base fee rises. EIP-1559 and EIP-7702 transactions are left to the plugin's filler, whose
// `maxFeePerGas` already has headroom.

const GWEI = 1_000_000_000n;

/**
 * The `gasPrice` for a legacy or EIP-2930 transaction: the larger of the node's `eth_gasPrice` and
 * twice the latest base fee, rounded up to a whole gwei. Twice the base fee survives six full
 * blocks of base-fee increases (1.125^6 ≈ 2.03).
 *
 * @param nodeGasPrice - The node's `eth_gasPrice`, in wei.
 * @param baseFeePerGas - The latest block's base fee, in wei.
 * @returns The gas price, in wei.
 */
export function legacyGasPrice(nodeGasPrice: bigint, baseFeePerGas: bigint): bigint {
  const price = nodeGasPrice > 2n * baseFeePerGas ? nodeGasPrice : 2n * baseFeePerGas;
  return ((price + GWEI - 1n) / GWEI) * GWEI;
}
