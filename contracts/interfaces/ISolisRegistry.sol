// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

interface ISolisRegistry {
    struct VersionInfo {
        uint256 version;
        address escrow;
        string semver;
        bool active;
        bool deprecated;
        uint64 registeredAt;
    }

    function latestVersion() external view returns (uint256);
    function getLatestEscrow() external view returns (address);
    function getEscrow(uint256 version) external view returns (address);
    function isRegisteredEscrow(address escrow) external view returns (bool);
}
