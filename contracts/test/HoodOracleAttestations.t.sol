// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {HoodOracleAttestations} from "../src/HoodOracleAttestations.sol";
import {IHoodOracleAttestations} from "../src/interfaces/IHoodOracleAttestations.sol";
import {
    AttestationExpired,
    InvalidAttestation,
    InvalidSignature,
    NothingPending,
    StaleAttestation,
    Timelocked,
    ZeroAddress
} from "../src/libraries/HoodErrors.sol";
import {HoodFixture} from "./utils/Fixture.sol";

contract HoodOracleAttestationsTest is HoodFixture {
    uint256 private otherKey = 0xB0B;

    function test_constructor() public {
        assertEq(attestations.signer(), signer);
        assertEq(attestations.signerEpoch(), 0);
        assertEq(attestations.owner(), protocolOwner);
        vm.expectRevert(ZeroAddress.selector);
        new HoodOracleAttestations(protocolOwner, address(0));
    }

    function test_typehashMatchesStruct() public view {
        assertEq(
            attestations.ATTESTATION_TYPEHASH(),
            keccak256(
                "Attestation(address token,uint8 score,uint8 tier,uint16 rugRiskBps,uint32 modelVersion,uint64 observedAt,uint64 expiresAt)"
            )
        );
    }

    function test_postStoresLatest() public {
        IHoodOracleAttestations.Attestation memory a = attestation(address(token), 72, 600);
        assertTrue(attestations.verify(a, sign(signerKey, a)));
        vm.expectEmit(address(attestations));
        emit IHoodOracleAttestations.Attested(
            a.token, a.score, a.tier, a.rugRiskBps, a.modelVersion, a.observedAt, a.expiresAt, address(this)
        );
        post(a);
        (IHoodOracleAttestations.Attestation memory stored, bool fresh) = attestations.latest(address(token));
        assertTrue(fresh);
        assertEq(stored.score, 72);
        assertEq(uint8(stored.tier), uint8(IHoodOracleAttestations.Tier.Strong));
        assertEq(stored.rugRiskBps, 1_200);
        assertEq(stored.modelVersion, 7);
        assertTrue(attestations.meets(address(token), 72));
        assertFalse(attestations.meets(address(token), 73));
    }

    function test_freshnessEndsAtExpiry() public {
        post(attestation(address(token), 72, 600));
        vm.warp(block.timestamp + 599);
        (, bool fresh) = attestations.latest(address(token));
        assertTrue(fresh);
        vm.warp(block.timestamp + 1);
        (, fresh) = attestations.latest(address(token));
        assertFalse(fresh);
        assertFalse(attestations.meets(address(token), 0));
    }

    function test_unknownTokenIsNotFresh() public view {
        (IHoodOracleAttestations.Attestation memory a, bool fresh) = attestations.latest(stranger);
        assertFalse(fresh);
        assertEq(a.expiresAt, 0);
    }

    function test_rejectsWrongSigner() public {
        IHoodOracleAttestations.Attestation memory a = attestation(address(token), 72, 600);
        bytes memory sig = sign(otherKey, a);
        assertFalse(attestations.verify(a, sig));
        vm.expectRevert(InvalidSignature.selector);
        attestations.post(a, sig);
    }

    function test_rejectsMalformedSignature() public {
        IHoodOracleAttestations.Attestation memory a = attestation(address(token), 72, 600);
        assertFalse(attestations.verify(a, hex"deadbeef"));
        vm.expectRevert(InvalidSignature.selector);
        attestations.post(a, hex"deadbeef");
    }

    function test_rejectsTamperedFields() public {
        IHoodOracleAttestations.Attestation memory a = attestation(address(token), 72, 600);
        bytes memory sig = sign(signerKey, a);
        a.score = 99;
        vm.expectRevert(InvalidSignature.selector);
        attestations.post(a, sig);
    }

    function test_signatureIsBoundToChainId() public {
        IHoodOracleAttestations.Attestation memory a = attestation(address(token), 72, 600);
        bytes memory sig = sign(signerKey, a);
        vm.chainId(4663);
        assertFalse(attestations.verify(a, sig));
    }

    function test_rejectsOutOfRangeFields() public {
        IHoodOracleAttestations.Attestation memory a = attestation(address(0), 72, 600);
        bytes memory sig = sign(signerKey, a);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestation.selector, "token"));
        attestations.post(a, sig);
        a = attestation(address(token), 101, 600);
        sig = sign(signerKey, a);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestation.selector, "score"));
        attestations.post(a, sig);
        a = attestation(address(token), 50, 600);
        a.rugRiskBps = 10_001;
        sig = sign(signerKey, a);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestation.selector, "rugRiskBps"));
        attestations.post(a, sig);
        a = attestation(address(token), 50, 600);
        a.observedAt = a.expiresAt + 1;
        sig = sign(signerKey, a);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestation.selector, "observedAt"));
        attestations.post(a, sig);
    }

    function test_rejectsExpired() public {
        IHoodOracleAttestations.Attestation memory a = attestation(address(token), 72, 600);
        a.observedAt = uint64(block.timestamp) - 1_000;
        a.expiresAt = uint64(block.timestamp);
        bytes memory sig = sign(signerKey, a);
        vm.expectRevert(abi.encodeWithSelector(AttestationExpired.selector, a.expiresAt, block.timestamp));
        attestations.post(a, sig);
    }

    function test_rejectsStaleReplayButAcceptsNewer() public {
        IHoodOracleAttestations.Attestation memory older = attestation(address(token), 40, 600);
        vm.warp(block.timestamp + 10);
        IHoodOracleAttestations.Attestation memory newer = attestation(address(token), 80, 600);
        post(newer);
        bytes memory olderSig = sign(signerKey, older);
        vm.expectRevert(abi.encodeWithSelector(StaleAttestation.selector, older.observedAt, newer.observedAt));
        attestations.post(older, olderSig);
        post(newer);
        (IHoodOracleAttestations.Attestation memory stored,) = attestations.latest(address(token));
        assertEq(stored.score, 80);
    }

    function test_signerRotationIsTimelocked() public {
        address next = vm.addr(otherKey);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        attestations.proposeSigner(next);
        vm.startPrank(protocolOwner);
        vm.expectRevert(ZeroAddress.selector);
        attestations.proposeSigner(address(0));
        vm.expectRevert(NothingPending.selector);
        attestations.applySigner();
        vm.expectEmit(address(attestations));
        emit IHoodOracleAttestations.SignerProposed(signer, next, block.timestamp + 1 hours);
        attestations.proposeSigner(next);
        vm.expectRevert(abi.encodeWithSelector(Timelocked.selector, block.timestamp + 1 hours));
        attestations.applySigner();
        vm.warp(block.timestamp + 1 hours);
        vm.expectEmit(address(attestations));
        emit IHoodOracleAttestations.SignerRotated(signer, next, 0);
        attestations.applySigner();
        vm.stopPrank();
        assertEq(attestations.signer(), next);
        assertEq(attestations.pendingSigner(), address(0));
        assertEq(attestations.pendingSignerEffectiveAt(), 0);
        assertEq(attestations.signerEpoch(), 0);

        IHoodOracleAttestations.Attestation memory a = attestation(address(token), 55, 600);
        assertFalse(attestations.verify(a, sign(signerKey, a)));
        attestations.post(a, sign(otherKey, a));
        assertTrue(attestations.meets(address(token), 55));
    }

    function test_plannedRotationKeepsOldAttestationsUntilExpiry() public {
        post(attestation(address(token), 66, 3 hours));
        vm.startPrank(protocolOwner);
        attestations.proposeSigner(vm.addr(otherKey));
        vm.warp(block.timestamp + 1 hours);
        attestations.applySigner();
        vm.stopPrank();
        assertTrue(attestations.meets(address(token), 66));
    }

    function test_cancelSigner() public {
        vm.startPrank(protocolOwner);
        vm.expectRevert(NothingPending.selector);
        attestations.cancelSigner();
        attestations.proposeSigner(vm.addr(otherKey));
        attestations.cancelSigner();
        assertEq(attestations.pendingSigner(), address(0));
        vm.expectRevert(NothingPending.selector);
        attestations.applySigner();
        vm.stopPrank();
    }

    function test_revokeInvalidatesEverythingTheSignerPosted() public {
        post(attestation(address(token), 90, 3 hours));
        vm.prank(protocolOwner);
        attestations.proposeSigner(vm.addr(otherKey));
        vm.prank(protocolOwner);
        vm.expectEmit(address(attestations));
        emit IHoodOracleAttestations.SignerRevoked(signer, 1);
        attestations.revokeSigner();
        assertEq(attestations.signer(), address(0));
        assertEq(attestations.signerEpoch(), 1);
        assertEq(attestations.pendingSigner(), address(0));
        (, bool fresh) = attestations.latest(address(token));
        assertFalse(fresh);
        assertFalse(attestations.meets(address(token), 0));

        IHoodOracleAttestations.Attestation memory a = attestation(address(token), 90, 600);
        bytes memory oldSig = sign(signerKey, a);
        assertFalse(attestations.verify(a, oldSig));
        vm.expectRevert(InvalidSignature.selector);
        attestations.post(a, oldSig);

        vm.startPrank(protocolOwner);
        attestations.proposeSigner(vm.addr(otherKey));
        vm.warp(block.timestamp + 1 hours);
        attestations.applySigner();
        vm.stopPrank();
        IHoodOracleAttestations.Attestation memory b = attestation(address(token), 20, 600);
        attestations.post(b, sign(otherKey, b));
        (IHoodOracleAttestations.Attestation memory stored, bool freshAgain) = attestations.latest(address(token));
        assertTrue(freshAgain);
        assertEq(stored.score, 20);
    }

    function test_domainSeparatorMatchesEip712() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("HoodOracleAttestations"),
                keccak256("1"),
                block.chainid,
                address(attestations)
            )
        );
        assertEq(attestations.domainSeparator(), expected);
    }
}
