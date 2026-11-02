import type { Address, Hex } from "viem";

/** The root of Safe's hosted Transaction Service; each chain has its own path under it. */
const SAFE_GATEWAY = "https://api.safe.global/tx-service";

/**
 * The chains Safe's hosted Transaction Service serves, with the short name of each, as
 * `@safe-global/api-kit` 5.0.4 lists them (`networks` in `src/utils/config.ts`). The service of
 * a chain is `https://api.safe.global/tx-service/<shortName>`, and the Safe app names a Safe as
 * `<shortName>:<address>`. The conformance test checks this table against api-kit's.
 */
export const SERVICE_CHAINS: ReadonlyMap<bigint, string> = new Map<bigint, string>([
  [1n, "eth"],
  [10n, "oeth"],
  [50n, "xdc"],
  [56n, "bnb"],
  [100n, "gno"],
  [130n, "unichain"],
  [137n, "pol"],
  [143n, "monad"],
  [146n, "sonic"],
  [196n, "okb"],
  [204n, "opbnb"],
  [324n, "zksync"],
  [480n, "wc"],
  [677n, "bot"],
  [988n, "stable"],
  [999n, "hyper"],
  [1001n, "kairos"],
  [1672n, "pharos"],
  [1874n, "wch-sepolia"],
  [2818n, "morph"],
  [3338n, "peaq"],
  [4217n, "tempo"],
  [4326n, "mega"],
  [4663n, "robinhood"],
  [5000n, "mantle"],
  [5003n, "mnt-sep"],
  [5042n, "arc"],
  [8217n, "kaia"],
  [8453n, "base"],
  [9745n, "plasma"],
  [10143n, "monad-testnet"],
  [10200n, "chi"],
  [16661n, "0g"],
  [25363n, "fluent"],
  [36900n, "adi"],
  [42161n, "arb1"],
  [42220n, "celo"],
  [42431n, "tempo-moderato"],
  [43111n, "hemi"],
  [43114n, "avax"],
  [46630n, "robinhood-testnet"],
  [57073n, "ink"],
  [59144n, "linea"],
  [80069n, "bep"],
  [80094n, "berachain"],
  [84532n, "basesep"],
  [102030n, "ctc"],
  [534352n, "scr"],
  [747474n, "katana"],
  [936485n, "zenith-testnet"],
  [5042002n, "arc-testnet"],
  [11142220n, "celo-sep"],
  [11155111n, "sep"],
  [1313161554n, "aurora"],
]);

/**
 * The root of the Transaction Service for a chain: the configured one, else Safe's hosted one.
 *
 * @param chainId - The chain.
 * @param services - `kmsSafe.services`, by decimal chain id.
 * @returns The root URL and whether it is Safe's hosted service, or `undefined` when neither
 *   serves the chain.
 */
export function serviceFor(
  chainId: bigint,
  services: Readonly<Record<string, string>>,
): { url: string; hosted: boolean } | undefined {
  const configured = Object.hasOwn(services, chainId.toString())
    ? services[chainId.toString()]
    : undefined;
  if (configured !== undefined) {
    return { url: configured, hosted: false };
  }
  const shortName = SERVICE_CHAINS.get(chainId);
  return shortName === undefined
    ? undefined
    : { url: `${SAFE_GATEWAY}/${shortName}`, hosted: true };
}

/**
 * The Safe app's page for a queued transaction.
 *
 * @param chainId - The chain.
 * @param safe - The Safe, checksummed.
 * @param safeTxHash - The SafeTx hash.
 * @returns The link, or `undefined` for a chain the table does not list.
 */
export function safeAppLink(chainId: bigint, safe: Address, safeTxHash: Hex): string | undefined {
  const shortName = SERVICE_CHAINS.get(chainId);
  return shortName === undefined
    ? undefined
    : `https://app.safe.global/transactions/tx?safe=${shortName}:${safe}&id=multisig_${safe}_${safeTxHash}`;
}
