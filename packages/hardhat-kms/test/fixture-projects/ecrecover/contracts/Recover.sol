// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Recovers the signer of a digest, refusing high-S signatures as OpenZeppelin's ECDSA does, so
/// a signature that passes was normalized by the signer.
contract Recover {
    uint256 private constant HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) external pure returns (address) {
        require(uint256(s) <= HALF_ORDER, "high s");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "invalid signature");
        return signer;
    }
}
