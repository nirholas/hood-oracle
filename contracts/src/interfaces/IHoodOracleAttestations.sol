// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title IHoodOracleAttestations
/// @notice The conviction oracle's on-chain voice. The off-chain oracle signs
///         one EIP-712 attestation per scored launch; anyone can post it; the
///         contract keeps the latest per token so an arm policy with
///         `minOracleScore > 0` can be enforced by the chain itself.
interface IHoodOracleAttestations {
    /// @notice Mirrors `OracleTier` in `src/types.ts`, in the same order.
    enum Tier {
        Prime,
        Strong,
        Lean,
        Watch,
        Avoid
    }

    /// @notice One scored launch. `score` is 0..100, `rugRiskBps` is the rug
    ///         probability in basis points (0..10000), `modelVersion` is the
    ///         oracle model row that produced it, `observedAt` is when the
    ///         features were snapshotted and `expiresAt` is when the score
    ///         stops being fresh enough to gate a buy.
    struct Attestation {
        address token;
        uint8 score;
        Tier tier;
        uint16 rugRiskBps;
        uint32 modelVersion;
        uint64 observedAt;
        uint64 expiresAt;
    }

    event Attested(
        address indexed token,
        uint8 score,
        Tier tier,
        uint16 rugRiskBps,
        uint32 modelVersion,
        uint64 observedAt,
        uint64 expiresAt,
        address indexed poster
    );
    event SignerProposed(address indexed current, address indexed proposed, uint256 effectiveAt);
    event SignerRotated(address indexed previous, address indexed current, uint64 epoch);
    event SignerRevoked(address indexed previous, uint64 epoch);

    /// @notice The EIP-712 type hash of `Attestation`.
    function ATTESTATION_TYPEHASH() external view returns (bytes32);

    /// @notice The key attestations must be signed with right now (zero after a revoke).
    function signer() external view returns (address);

    /// @notice Bumped on every emergency revoke; attestations posted under an older epoch read as absent.
    function signerEpoch() external view returns (uint64);

    /// @notice Store `attestation` as the latest for its token if the signature is valid,
    ///         it is not expired and it is not older than what is stored.
    function post(Attestation calldata attestation, bytes calldata signature) external;

    /// @notice True when `signature` over `attestation` recovers to the active signer.
    function verify(Attestation calldata attestation, bytes calldata signature) external view returns (bool);

    /// @notice The EIP-712 digest a signer must sign for `attestation`.
    function digest(Attestation calldata attestation) external view returns (bytes32);

    /// @notice The stored attestation for `token` and whether it is usable
    ///         (posted under the current signer epoch and not expired).
    function latest(address token) external view returns (Attestation memory attestation, bool fresh);

    /// @notice True when `token` has a fresh attestation with `score >= minScore`.
    function meets(address token, uint8 minScore) external view returns (bool);
}
