// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HoodArmAccount} from "../src/HoodArmAccount.sol";
import {HoodArmFactory} from "../src/HoodArmFactory.sol";
import {HoodFeeSplitter} from "../src/HoodFeeSplitter.sol";
import {HoodOracleAttestations} from "../src/HoodOracleAttestations.sol";
import {Policy} from "../src/libraries/PolicyLib.sol";

/// @title Deploy
/// @notice Deploys the whole on-chain arm to Robinhood Chain (4663):
///         the account implementation, the attestations contract, the fee
///         splitter (the factory's fee recipient) and the factory.
///
///         Environment:
///           PRIVATE_KEY           deployer and protocol owner (factory + attestations)
///           FEE_RECIPIENT         first splitter payee; the splitter is the factory's recipient
///           ORACLE_SIGNER         the oracle's attestation signing address
///           PERFORMANCE_FEE_BPS   0..2000
///           SPLITTER_PAYEES       optional, comma-separated; defaults to [FEE_RECIPIENT]
///           SPLITTER_SHARES       optional, comma-separated; defaults to [1]
///           ROUTER / WETH         optional overrides; default to the 4663 mainnet addresses
///           DEFAULT_*             optional default-policy overrides (see `_defaultPolicy`)
contract Deploy is Script {
    address internal constant ROUTER_4663 = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant WETH_4663 = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    struct Config {
        uint256 key;
        address deployer;
        address feeRecipient;
        address oracleSigner;
        uint16 feeBps;
        address router;
        address weth;
        address[] payees;
        uint256[] shares;
    }

    struct Deployed {
        address implementation;
        address attestations;
        address splitter;
        address factory;
    }

    function run() external {
        Config memory cfg = _config();
        Deployed memory d = _deploy(cfg);
        _report(cfg, d);
    }

    function _config() internal view returns (Config memory cfg) {
        cfg.key = vm.envUint("PRIVATE_KEY");
        cfg.deployer = vm.addr(cfg.key);
        cfg.feeRecipient = vm.envAddress("FEE_RECIPIENT");
        cfg.oracleSigner = vm.envAddress("ORACLE_SIGNER");
        cfg.feeBps = uint16(vm.envUint("PERFORMANCE_FEE_BPS"));
        cfg.router = vm.envOr("ROUTER", ROUTER_4663);
        cfg.weth = vm.envOr("WETH", WETH_4663);
        address[] memory defaultPayees = new address[](1);
        defaultPayees[0] = cfg.feeRecipient;
        uint256[] memory defaultShares = new uint256[](1);
        defaultShares[0] = 1;
        cfg.payees = vm.envOr("SPLITTER_PAYEES", ",", defaultPayees);
        cfg.shares = vm.envOr("SPLITTER_SHARES", ",", defaultShares);
    }

    function _deploy(Config memory cfg) internal returns (Deployed memory d) {
        Policy memory defaults = _defaultPolicy(cfg.router, cfg.weth);
        vm.startBroadcast(cfg.key);
        d.implementation = address(new HoodArmAccount());
        d.attestations = address(new HoodOracleAttestations(cfg.deployer, cfg.oracleSigner));
        d.splitter = address(new HoodFeeSplitter(cfg.payees, cfg.shares));
        d.factory = address(
            new HoodArmFactory(
                cfg.deployer, d.implementation, d.attestations, cfg.weth, d.splitter, cfg.feeBps, defaults
            )
        );
        vm.stopBroadcast();
    }

    function _report(Config memory cfg, Deployed memory d) internal view {
        console.log("chain id              ", block.chainid);
        console.log("deployer / owner      ", cfg.deployer);
        console.log("HoodArmAccount impl   ", d.implementation);
        console.log("HoodOracleAttestations", d.attestations);
        console.log("HoodFeeSplitter       ", d.splitter);
        console.log("HoodArmFactory        ", d.factory);
        console.log("oracle signer         ", cfg.oracleSigner);
        console.log("performance fee bps   ", cfg.feeBps);
        console.log("router                ", cfg.router);
        console.log("weth                  ", cfg.weth);
    }

    /// @dev A probation-tier template: small, slow, one position, 10% slippage,
    ///      no oracle floor. Owners set their own policy per account.
    function _defaultPolicy(address router, address weth) internal view returns (Policy memory) {
        return Policy({
            perTradeCapWei: uint128(vm.envOr("DEFAULT_PER_TRADE_CAP_WEI", uint256(0.01 ether))),
            dailyBudgetWei: uint128(vm.envOr("DEFAULT_DAILY_BUDGET_WEI", uint256(0.05 ether))),
            maxOpenPositions: uint16(vm.envOr("DEFAULT_MAX_OPEN_POSITIONS", uint256(1))),
            maxSlippageBps: uint16(vm.envOr("DEFAULT_MAX_SLIPPAGE_BPS", uint256(1_000))),
            cooldownSeconds: uint32(vm.envOr("DEFAULT_COOLDOWN_SECONDS", uint256(30))),
            maxHoldSecondsHint: uint32(vm.envOr("DEFAULT_MAX_HOLD_SECONDS_HINT", uint256(3_600))),
            minOracleScore: uint8(vm.envOr("DEFAULT_MIN_ORACLE_SCORE", uint256(0))),
            allowedRouter: router,
            quoteToken: weth
        });
    }
}
