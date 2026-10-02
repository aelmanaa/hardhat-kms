// The library account's public types. They are written without viem's types, so a project that
// does not install viem still typechecks. A type test checks that they are assignable to viem's
// `LocalAccount` (test/unit/viem/types.test.ts).

/** A `0x`-prefixed hex string, as viem's `Hex`. */
export type KmsHex = `0x${string}`;

/** A message for `signMessage`: UTF-8 text, or bytes given as hex or as a `Uint8Array`. */
export type KmsSignableMessage = string | { raw: KmsHex | Uint8Array };

/**
 * EIP-712 typed data, as viem's `signTypedData` takes it. The fields are typed loosely so that
 * viem's generic `TypedDataDefinition` is assignable to it; the account checks them at run time.
 */
export interface KmsTypedDataDefinition {
  /** The domain, an object; typed data without one has an empty domain. */
  domain?: unknown;
  /**
   * The struct types, each a list of `{ name, type }` fields. `EIP712Domain` may be left out: it
   * follows from `domain`. Absent when `primaryType` is `EIP712Domain`.
   */
  types?: unknown;
  /** The name of the type of `message`. */
  primaryType: unknown;
  /** The values to sign, an object. Absent when `primaryType` is `EIP712Domain`. */
  message?: unknown;
}

/** An entry of an access list. */
export interface KmsAccessListEntry {
  address: KmsHex;
  storageKeys: readonly KmsHex[];
}

/** An EIP-7702 authorization to sign, as viem's `AuthorizationRequest`. */
export interface KmsAuthorizationRequest {
  /** The address of the code to delegate to. */
  address?: KmsHex | undefined;
  /** Another name for `address`, as in viem. */
  contractAddress?: KmsHex | undefined;
  /** The chain the authorization is valid on; 0 is every chain. */
  chainId: number;
  /** The authority's nonce. */
  nonce: number;
}

/** A signed EIP-7702 authorization in a transaction's `authorizationList`, as viem takes it. */
export interface KmsAuthorizationListEntry {
  address: KmsHex;
  chainId: number;
  nonce: number;
  r: KmsHex;
  s: KmsHex;
  /** 27 or 28; used when `yParity` is absent. */
  v?: bigint | undefined;
  /** 0 or 1. */
  yParity?: number | undefined;
}

/** A signed EIP-7702 authorization, as `signAuthorization` returns it, in viem's form. */
export interface KmsSignedAuthorization {
  /** The address of the code to delegate to, as it was requested. */
  address: KmsHex;
  chainId: number;
  nonce: number;
  /** 32 bytes. */
  r: KmsHex;
  /** 32 bytes, in the lower half of the curve order. */
  s: KmsHex;
  /** 27 or 28. */
  v: bigint;
  /** 0 or 1. */
  yParity: number;
}

/**
 * A transaction for `signTransaction`, in viem's `TransactionSerializable` fields. Only types
 * `legacy`, `eip2930`, `eip1559` and `eip7702` are signed.
 */
export interface KmsTransactionRequest {
  type?: string | undefined;
  chainId?: number | undefined;
  nonce?: number | undefined;
  gas?: bigint | undefined;
  to?: KmsHex | null | undefined;
  value?: bigint | undefined;
  data?: KmsHex | undefined;
  gasPrice?: bigint | undefined;
  maxFeePerGas?: bigint | undefined;
  maxPriorityFeePerGas?: bigint | undefined;
  accessList?: readonly KmsAccessListEntry[] | undefined;
  authorizationList?: readonly KmsAuthorizationListEntry[] | undefined;
}

/**
 * A chain's transaction serializer, as viem passes it. Written as a method type, so that viem's
 * serializers, whose parameter is viem's own transaction type, are assignable to it.
 */
export type KmsTransactionSerializer = {
  /**
   * @param transaction - The transaction.
   * @returns The serialized transaction, as hex.
   */
  serialize(transaction: KmsTransactionRequest): unknown;
}["serialize"];

/** The options viem passes to `signTransaction`. */
export interface KmsSignTransactionOptions {
  /**
   * A chain's transaction serializer. The account serializes with its own code; when a
   * serializer is given, its unsigned bytes must be the same, or nothing is signed.
   */
  serializer?: KmsTransactionSerializer | undefined;
}

/**
 * A viem local account whose key is a KMS key, from `connection.kms.getAccount`. Pass it to
 * viem as `account`, or as the owner of a smart account.
 *
 * Sends through it bypass the plugin's send lock, nonce tracking and retry cache: viem fills the
 * transaction and sends it with `eth_sendRawTransaction` itself. To send from a KMS account, use
 * `connection.viem.getWalletClient(address)` instead.
 */
export interface KmsAccount {
  /** The checksummed address. */
  readonly address: KmsHex;
  /** The uncompressed public key, 65 bytes starting with `0x04`. */
  readonly publicKey: KmsHex;
  /** Where the account comes from. */
  readonly source: "hardhat-kms";
  /** Always `local`: viem signs with it rather than asking the node. */
  readonly type: "local";
  /**
   * Signs an EIP-191 personal message.
   *
   * @param parameters - The message.
   * @returns The 65-byte `r || s || v` signature.
   */
  readonly signMessage: (parameters: { message: KmsSignableMessage }) => Promise<KmsHex>;
  /**
   * Signs EIP-712 typed data. Typed data whose `domain.chainId` is another chain than the
   * connection's is refused, unless `kms.allowCrossChainTypedData` is set.
   *
   * @param parameters - The typed data.
   * @returns The 65-byte `r || s || v` signature.
   */
  readonly signTypedData: (parameters: KmsTypedDataDefinition) => Promise<KmsHex>;
  /**
   * Signs a transaction of type `legacy`, `eip2930`, `eip1559` or `eip7702`, whose `chainId`
   * must be the connection's.
   *
   * @param transaction - The transaction.
   * @param options - The chain serializer viem passes, if any.
   * @returns The signed transaction, serialized.
   */
  readonly signTransaction: (
    transaction: KmsTransactionRequest,
    options?: KmsSignTransactionOptions,
  ) => Promise<KmsHex>;
  /**
   * Signs an EIP-7702 authorization for the connection's chain. Chain 0 needs the
   * `allowChainZeroAuthorization` option of `getAccount`.
   *
   * @param parameters - The delegate, chain and nonce.
   * @returns The signed authorization.
   */
  readonly signAuthorization: (
    parameters: KmsAuthorizationRequest,
  ) => Promise<KmsSignedAuthorization>;
}

/** A {@link KmsAccount} that also signs bare digests, from `getAccount(address, { rawSign: true })`. */
export interface KmsRawSignAccount extends KmsAccount {
  /**
   * Signs a 32-byte digest as it is, with no prefix. Whatever the digest stands for is signed,
   * a transaction for any chain included.
   *
   * @param parameters - The digest.
   * @returns The 65-byte `r || s || v` signature.
   */
  readonly sign: (parameters: { hash: KmsHex }) => Promise<KmsHex>;
}

/** Options of `connection.kms.getAccount`. */
export interface KmsAccountOptions {
  /**
   * Add `sign({ hash })`, which signs a bare digest. Off by default (decision 0014); some smart
   * account owners need it. A warning is printed when it is on.
   */
  rawSign?: boolean | undefined;
  /** Let `signAuthorization` sign for chain 0, which makes the authorization valid on every chain. */
  allowChainZeroAuthorization?: boolean | undefined;
}

/** What hardhat-kms adds to a network connection, as `connection.kms`. */
export interface KmsNetworkConnection {
  /**
   * Returns a viem local account for a KMS account of this connection. It needs the `viem`
   * package, and asks the KMS for the key's public key once.
   *
   * @param address - The address of one of the connection's KMS accounts.
   * @param options - Options; `rawSign: true` adds `sign({ hash })`.
   * @returns The account.
   */
  readonly getAccount: {
    (address: string, options: KmsAccountOptions & { rawSign: true }): Promise<KmsRawSignAccount>;
    (address: string, options?: KmsAccountOptions): Promise<KmsAccount>;
  };
}
