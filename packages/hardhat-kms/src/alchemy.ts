/**
 * A check for Alchemy's Wallet APIs: `checkPreparedCalls` reads what `prepareCalls` of
 * `@alchemy/wallet-apis` returned and refuses it unless the KMS key would sign exactly the calls
 * you asked for. Call it between `prepareCalls` and `signPreparedCalls`.
 *
 * This entry point needs viem, an optional peer dependency of hardhat-kms. It does not depend on
 * `@alchemy/wallet-apis`; it reads the response shape of version 5.3.0.
 *
 * @module hardhat-kms/alchemy
 */

export {
  checkPreparedCalls,
  type PreparedCallsExpectation,
  type RequestedCall,
} from "./internal/alchemy/prepared-calls.ts";
