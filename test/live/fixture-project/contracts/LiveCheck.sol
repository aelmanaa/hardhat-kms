// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// The contract the live tests deploy on Sepolia. Only its deployer can call `add`, so a write that
/// succeeds came from the KMS account. The `recover` functions rebuild the EIP-191 and EIP-712
/// digests on chain and recover the signer with `ecrecover`, refusing high-S signatures as
/// OpenZeppelin's ECDSA does.
///
/// The KMS account also delegates to this contract with EIP-7702, and the test clears the
/// delegation before it ends. While delegated, the account runs this code against its own storage:
/// `add` accepts only the account itself, the rest is pure or a view, and `receive` keeps plain
/// transfers to the account working.
contract LiveCheck {
    uint256 private constant HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant CHECK_TYPEHASH = keccak256("Check(address account,uint256 count)");

    address public immutable owner;
    uint256 public count;

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    function add(uint256 amount) external {
        require(msg.sender == owner, "not the owner");
        count += amount;
    }

    /// Recovers the signer of a `personal_sign` over 32 raw bytes.
    function recoverPersonal(bytes32 message, uint8 v, bytes32 r, bytes32 s) external pure returns (address) {
        return recover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", message)), v, r, s);
    }

    /// Recovers the signer of `Check(account, count)` signed with `eth_signTypedData_v4` for this
    /// contract on this chain.
    function recoverCheck(address account, uint256 value, uint8 v, bytes32 r, bytes32 s)
        external
        view
        returns (address)
    {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("hardhat-kms live"), keccak256("1"), block.chainid, address(this)
            )
        );
        bytes32 structHash = keccak256(abi.encode(CHECK_TYPEHASH, account, value));
        return recover(keccak256(abi.encodePacked("\x19\x01", domain, structHash)), v, r, s);
    }

    function recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) public pure returns (address) {
        require(uint256(s) <= HALF_ORDER, "high s");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "invalid signature");
        return signer;
    }
}
