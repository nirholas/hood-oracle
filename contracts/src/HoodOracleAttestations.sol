// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IHoodOracleAttestations} from "./interfaces/IHoodOracleAttestations.sol";
import {
    AttestationExpired,
    InvalidAttestation,
    InvalidSignature,
    NothingPending,
    StaleAttestation,
    Timelocked,
    ZeroAddress
} from "./libraries/HoodErrors.sol";

/// @title HoodOracleAttestations
/// @notice The conviction oracle's signed scores, on chain. The off-chain
///         oracle (`src/oracle/`) signs one EIP-712 `Attestation` per scored
///         launch with its signer key; anyone can `post` it (the engine does,
///         a relayer can, a user can). The contract keeps the latest per token
///         and answers `latest` / `meets` so an arm with `minOracleScore > 0`
///         is gated by the chain, not by the engine's honesty.
///
///         Signer rotation is timelocked (1h) so a planned rotation is visible
///         before it lands; an emergency `revokeSigner` is immediate and bumps
///         the signer epoch, which makes every attestation the compromised key
///         ever posted read as absent. Tightening now, loosening later.
contract HoodOracleAttestations is IHoodOracleAttestations, EIP712, Ownable2Step {
    /// @inheritdoc IHoodOracleAttestations
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(address token,uint8 score,uint8 tier,uint16 rugRiskBps,uint32 modelVersion,uint64 observedAt,uint64 expiresAt)"
    );
    uint256 public constant SIGNER_TIMELOCK = 1 hours;
    uint8 public constant MAX_SCORE = 100;
    uint16 public constant MAX_RUG_RISK_BPS = 10_000;

    address public signer;
    uint64 public signerEpoch;
    address public pendingSigner;
    uint256 public pendingSignerEffectiveAt;

    mapping(address token => Attestation) private _latest;
    mapping(address token => uint64) private _epochOf;

    constructor(address owner_, address signer_) EIP712("HoodOracleAttestations", "1") Ownable(owner_) {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerRotated(address(0), signer_, 0);
    }

    // ── attestations ─────────────────────────────────────────────────────────

    /// @inheritdoc IHoodOracleAttestations
    function post(Attestation calldata attestation, bytes calldata signature) external {
        if (attestation.token == address(0)) revert InvalidAttestation("token");
        if (attestation.score > MAX_SCORE) revert InvalidAttestation("score");
        if (attestation.rugRiskBps > MAX_RUG_RISK_BPS) revert InvalidAttestation("rugRiskBps");
        if (attestation.observedAt > attestation.expiresAt) revert InvalidAttestation("observedAt");
        if (attestation.expiresAt <= block.timestamp) revert AttestationExpired(attestation.expiresAt, block.timestamp);
        if (!verify(attestation, signature)) revert InvalidSignature();

        Attestation storage stored = _latest[attestation.token];
        if (_epochOf[attestation.token] == signerEpoch && attestation.observedAt < stored.observedAt) {
            revert StaleAttestation(attestation.observedAt, stored.observedAt);
        }
        _latest[attestation.token] = attestation;
        _epochOf[attestation.token] = signerEpoch;
        emit Attested(
            attestation.token,
            attestation.score,
            attestation.tier,
            attestation.rugRiskBps,
            attestation.modelVersion,
            attestation.observedAt,
            attestation.expiresAt,
            msg.sender
        );
    }

    /// @inheritdoc IHoodOracleAttestations
    function verify(Attestation calldata attestation, bytes calldata signature) public view returns (bool) {
        address active = signer;
        if (active == address(0)) return false;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest(attestation), signature);
        return err == ECDSA.RecoverError.NoError && recovered == active;
    }

    /// @inheritdoc IHoodOracleAttestations
    function digest(Attestation calldata attestation) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ATTESTATION_TYPEHASH,
                    attestation.token,
                    attestation.score,
                    uint8(attestation.tier),
                    attestation.rugRiskBps,
                    attestation.modelVersion,
                    attestation.observedAt,
                    attestation.expiresAt
                )
            )
        );
    }

    /// @inheritdoc IHoodOracleAttestations
    function latest(address token) public view returns (Attestation memory attestation, bool fresh) {
        attestation = _latest[token];
        fresh = attestation.expiresAt > block.timestamp && _epochOf[token] == signerEpoch;
    }

    /// @inheritdoc IHoodOracleAttestations
    function meets(address token, uint8 minScore) external view returns (bool) {
        (Attestation memory a, bool fresh) = latest(token);
        return fresh && a.score >= minScore;
    }

    /// @notice The EIP-712 domain separator, for off-chain signers.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ── signer management ────────────────────────────────────────────────────

    /// @notice Queue a planned signer rotation. Takes effect after `SIGNER_TIMELOCK`.
    function proposeSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert ZeroAddress();
        pendingSigner = signer_;
        pendingSignerEffectiveAt = block.timestamp + SIGNER_TIMELOCK;
        emit SignerProposed(signer, signer_, pendingSignerEffectiveAt);
    }

    /// @notice Land a queued rotation. Attestations by the previous signer stay valid until they expire.
    function applySigner() external onlyOwner {
        uint256 effectiveAt = pendingSignerEffectiveAt;
        if (effectiveAt == 0) revert NothingPending();
        if (block.timestamp < effectiveAt) revert Timelocked(effectiveAt);
        emit SignerRotated(signer, pendingSigner, signerEpoch);
        signer = pendingSigner;
        pendingSigner = address(0);
        pendingSignerEffectiveAt = 0;
    }

    /// @notice Drop a queued rotation.
    function cancelSigner() external onlyOwner {
        if (pendingSignerEffectiveAt == 0) revert NothingPending();
        pendingSigner = address(0);
        pendingSignerEffectiveAt = 0;
        emit SignerProposed(signer, address(0), 0);
    }

    /// @notice Emergency: stop trusting the signer now and invalidate everything it posted.
    ///         No attestation verifies until a new signer is proposed and applied.
    function revokeSigner() external onlyOwner {
        address previous = signer;
        signer = address(0);
        signerEpoch += 1;
        pendingSigner = address(0);
        pendingSignerEffectiveAt = 0;
        emit SignerRevoked(previous, signerEpoch);
    }
}
