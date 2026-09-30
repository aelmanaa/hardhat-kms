import type { TypedData } from "../../src/internal/crypto/digests.ts";

// Test vectors from Hardhat's own local-accounts tests
// (packages/hardhat/test/internal/builtin-plugins/network-manager/request-handlers/handlers/accounts/local-accounts.ts).
// A deterministic signer (RFC 6979, no extra entropy) must reproduce these results exactly.

/** Hardhat's first default account. */
export const HARDHAT_ACCOUNT_0 = {
  secretKey: "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
};

/** keccak256("cow"), the key of the EIP-712 specification example. */
export const COW_ACCOUNT = {
  secretKey: "c85ef7d79691fe79573b1a7064c19c1a9819ebdbd1faaab1a8ec92344438aaf4",
  address: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
};

// The EIP-712 example from the specification, as used in Hardhat's own tests.
/** The EIP-712 specification example. */
export const EIP712_MAIL: TypedData = {
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
};

/** Expected `eth_signTypedData_v4` result for {@link EIP712_MAIL} signed by {@link COW_ACCOUNT}. */
export const EIP712_MAIL_SIGNATURE =
  "0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b915621c";

/** `personal_sign` vectors for {@link HARDHAT_ACCOUNT_0}, recorded against Geth and MetaMask. */
export const PERSONAL_SIGN_VECTORS = [
  {
    source: "geth",
    message: "5417aa2a18a44da0675524453ff108c545382f0d7e26605c56bba47c21b5e979",
    signature:
      "0x9c73dd4937a37eecab3abb54b74b6ec8e500080431d36afedb1726624587ee6710296e10c1194dded7376f13ff03ef6c9e797eb86bae16c20c57776fc69344271c",
  },
  {
    source: "metamask",
    message: "7699f568ecd7753e6ddf75a42fa4c2cc86cbbdc704c9eb1a6b6d4b9d8b8d1519",
    signature:
      "0x2875e4206c9fe3b229291c81f95cc4f421e2f4d3e023f5b4041daa56ab4000977010b47a3c01036ec8a6a0872aec2ab285150f003d01b0d8da60c1cceb9154181c",
  },
] as const;
