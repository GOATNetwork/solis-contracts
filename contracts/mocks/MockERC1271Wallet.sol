// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract MockERC1271Wallet is IERC1271 {
    bytes4 private constant MAGIC_VALUE = 0x1626ba7e;
    bytes4 private constant INVALID_VALUE = 0xffffffff;

    address public owner;

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    function setOwner(address newOwner) external {
        require(msg.sender == owner, "MockERC1271Wallet: caller is not owner");
        owner = newOwner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recoverCalldata(hash, signature) == owner ? MAGIC_VALUE : INVALID_VALUE;
    }
}
