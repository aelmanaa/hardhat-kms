// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// A counter that only its deployer can change, so a successful `add` came from the deployer.
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
