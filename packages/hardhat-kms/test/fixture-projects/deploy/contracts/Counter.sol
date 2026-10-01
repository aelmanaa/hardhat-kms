// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// A counter only its deployer can change, so a write that succeeds came from the account that
/// deployed the contract.
contract Counter {
    address public immutable owner;
    string public label;
    uint256 public count;

    constructor(string memory label_, uint256 start) {
        owner = msg.sender;
        label = label_;
        count = start;
    }

    function add(uint256 amount) external {
        require(msg.sender == owner, "not the owner");
        count += amount;
    }
}
