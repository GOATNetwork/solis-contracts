// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.35;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ISolisRegistry} from "./interfaces/ISolisRegistry.sol";

interface ISolisEscrowRegistrationMetadata {
    function registryVersion() external view returns (uint256);
    function registry() external view returns (address);
    function ESCROW_VERSION() external view returns (string memory);
}

/// @title SolisRegistry
/// @notice Tracks escrow contract versions for clients without using proxy upgrades.
/// @dev Registry changes only affect discovery for new Matters. Existing Matters remain in their original escrow.
contract SolisRegistry is Ownable, ISolisRegistry {
    /// @notice Version metadata keyed by registry version number.
    mapping(uint256 => VersionInfo) public versions;
    /// @notice Reverse lookup from escrow address to registry version.
    mapping(address => uint256) public escrowVersion;

    /// @notice Version currently recommended for new Matter submissions.
    uint256 public latestVersion;

    event VersionRegistered(uint256 indexed version, address indexed escrow, string semver);
    event LatestVersionUpdated(uint256 indexed oldVersion, uint256 indexed newVersion, address indexed escrow);
    event VersionDeprecated(uint256 indexed version, address indexed escrow);
    event VersionReactivated(uint256 indexed version, address indexed escrow);

    error InvalidVersion();
    error VersionAlreadyRegistered(uint256 version);
    error VersionNotRegistered(uint256 version);
    error EscrowAlreadyRegistered(address escrow);
    error InvalidEscrowAddress(address escrow);
    error InvalidEscrowMetadata(address escrow);
    error InvalidSemver();
    error VersionNotActive(uint256 version);

    /// @param initialOwner Owner account that can register and route versions. Use a multisig in production.
    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Registers a new escrow version.
    /// @dev Registration records only routing metadata. Bytecode verification remains an off-chain concern.
    function registerVersion(uint256 version, address escrow, string calldata semver) external onlyOwner {
        if (version == 0) revert InvalidVersion();
        if (versions[version].escrow != address(0)) {
            revert VersionAlreadyRegistered(version);
        }
        if (escrow == address(0) || escrow.code.length == 0) {
            revert InvalidEscrowAddress(escrow);
        }
        if (escrowVersion[escrow] != 0) revert EscrowAlreadyRegistered(escrow);
        if (bytes(semver).length == 0) revert InvalidSemver();
        _validateEscrowMetadata(version, escrow, semver);

        versions[version] = VersionInfo({
            version: version,
            escrow: escrow,
            semver: semver,
            active: true,
            deprecated: false,
            registeredAt: uint64(block.timestamp)
        });
        escrowVersion[escrow] = version;

        emit VersionRegistered(version, escrow, semver);

        // The first registered version becomes latest to avoid a separate bootstrap transaction.
        if (latestVersion == 0) {
            latestVersion = version;
            emit LatestVersionUpdated(0, version, escrow);
        }
    }

    /// @notice Marks an active registered version as the current discovery target.
    function setLatestVersion(uint256 version) external onlyOwner {
        VersionInfo storage info = _registeredVersion(version);
        if (!info.active || info.deprecated) revert VersionNotActive(version);

        uint256 oldVersion = latestVersion;
        latestVersion = version;

        emit LatestVersionUpdated(oldVersion, version, info.escrow);
    }

    /// @notice Deprecates a version so it cannot be selected as latest.
    /// @dev Does not affect Matters already funded in that escrow.
    function deprecateVersion(uint256 version) external onlyOwner {
        VersionInfo storage info = _registeredVersion(version);
        info.active = false;
        info.deprecated = true;

        if (latestVersion == version) {
            latestVersion = 0;
            emit LatestVersionUpdated(version, 0, address(0));
        }

        emit VersionDeprecated(version, info.escrow);
    }

    /// @notice Reactivates a previously deprecated version.
    /// @dev Reactivation does not automatically make the version latest.
    function reactivateVersion(uint256 version) external onlyOwner {
        VersionInfo storage info = _registeredVersion(version);
        info.active = true;
        info.deprecated = false;

        emit VersionReactivated(version, info.escrow);
    }

    /// @notice Returns the latest escrow address, or zero if no active latest version is set.
    function getLatestEscrow() external view returns (address) {
        if (latestVersion == 0) return address(0);
        return versions[latestVersion].escrow;
    }

    /// @notice Returns the escrow address for a version, or zero for unknown versions.
    function getEscrow(uint256 version) external view returns (address) {
        return versions[version].escrow;
    }

    /// @notice Returns true if `escrow` has been registered under any version.
    function isRegisteredEscrow(address escrow) external view returns (bool) {
        return escrowVersion[escrow] != 0;
    }

    function _registeredVersion(uint256 version) private view returns (VersionInfo storage info) {
        info = versions[version];
        if (info.escrow == address(0)) revert VersionNotRegistered(version);
    }

    function _validateEscrowMetadata(uint256 version, address escrow, string calldata semver) private view {
        ISolisEscrowRegistrationMetadata escrowMetadata = ISolisEscrowRegistrationMetadata(escrow);

        try escrowMetadata.registryVersion() returns (uint256 escrowVersion_) {
            if (escrowVersion_ != version) revert InvalidEscrowMetadata(escrow);
        } catch {
            revert InvalidEscrowMetadata(escrow);
        }

        try escrowMetadata.registry() returns (address escrowRegistry) {
            if (escrowRegistry != address(this)) revert InvalidEscrowMetadata(escrow);
        } catch {
            revert InvalidEscrowMetadata(escrow);
        }

        try escrowMetadata.ESCROW_VERSION() returns (string memory escrowSemver) {
            if (keccak256(bytes(escrowSemver)) != keccak256(bytes(semver))) revert InvalidEscrowMetadata(escrow);
        } catch {
            revert InvalidEscrowMetadata(escrow);
        }
    }
}
