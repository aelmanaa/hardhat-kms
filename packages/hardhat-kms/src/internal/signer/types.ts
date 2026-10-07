import type { TypedData } from "../crypto/digests.ts";
import type { SignatureOutput } from "../crypto/signature.ts";

/**
 * Per-call context passed to provider adapters.
 *
 * Stable from 1.0: a minor may add optional fields; changing or removing one needs a major.
 */
export interface SignContext {
  /** Aborted when the call times out or the caller gives up; adapters should pass it to their SDK. */
  signal: AbortSignal;
  /** Shows a status line to the user (for example while waiting for an approval). */
  displayMessage(message: string): Promise<void>;
  /** Identifies this call in the plugin's debug output. */
  requestId: string;
}

/**
 * What a key is, in terms that are safe to print.
 *
 * Stable from 1.0: a minor may add optional fields; changing or removing one needs a major.
 */
export interface KeyDescription {
  /** Provider id, for example `aws`. */
  provider: string;
  /**
   * The key the adapter signs with, as configured and safe to print. A provider that resolves a
   * more exact id on first use, such as the AWS key ARN, signs with that id.
   */
  pinnedId: string;
  /** How to show the key to users; identifiers that came from configuration variables are masked. */
  displayId: string;
}

/**
 * The contract every KMS/HSM provider implements.
 *
 * An adapter needs at least one way to identify the key (`getPublicKey` or `getAddress`) and
 * at least one way to sign. The core prefers the structured methods when present and falls back
 * to `signDigest`; it always verifies the returned signature against the key.
 *
 * Stable from 1.0: a minor may add optional methods; changing or removing one needs a major.
 * The Turnkey and Fireblocks providers add `signTransaction` and `sendTransaction` this way.
 */
export interface KmsKeyAdapter {
  /** Describes the key for messages and logs. */
  describe(): KeyDescription;
  /** Returns the 65-byte uncompressed public key. Called once per key and cached. */
  getPublicKey?(ctx: SignContext): Promise<Uint8Array>;
  /** Returns the key's address, for signers that cannot export a public key. */
  getAddress?(ctx: SignContext): Promise<string>;
  /** Signs a 32-byte digest. */
  signDigest?(request: { digest: Uint8Array }, ctx: SignContext): Promise<SignatureOutput>;
  /** Signs an EIP-191 message; `digest` is what the core expects to be signed. */
  signMessage?(
    request: { message: Uint8Array; digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput>;
  /** Signs EIP-712 typed data; `digest` is what the core expects to be signed. */
  signTypedData?(
    request: { typedData: TypedData; digest: Uint8Array },
    ctx: SignContext,
  ): Promise<SignatureOutput>;
  /** Releases SDK clients and connections. */
  close?(): Promise<void>;
}
