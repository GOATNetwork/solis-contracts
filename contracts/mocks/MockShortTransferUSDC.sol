// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {MockUSDC} from "./MockUSDC.sol";

contract MockShortTransferUSDC is MockUSDC {
    uint256 public immutable shortfall;

    constructor(uint256 initialShortfall) {
        shortfall = initialShortfall;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && shortfall != 0) {
            uint256 delivered = value > shortfall ? value - shortfall : 0;
            if (delivered != 0) {
                super._update(from, to, delivered);
            }
            super._update(from, address(0), value - delivered);
            return;
        }

        super._update(from, to, value);
    }
}
