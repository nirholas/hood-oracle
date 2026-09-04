// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {HoodArmAccount} from "../src/HoodArmAccount.sol";
import {HoodArmFactory} from "../src/HoodArmFactory.sol";
import {Policy} from "../src/libraries/PolicyLib.sol";

/// @title CreateArm
/// @notice Creates an arm account for the caller through a deployed factory,
///         with a policy assembled from the environment on top of the
///         factory's default template, and optionally funds it with ETH.
///
///         Environment:
///           PRIVATE_KEY                 the account owner (funds, policy, kill switch)
///           FACTORY                     HoodArmFactory address
///           OPERATOR                    the engine's hot key (TRADER_PRIVATE_KEY's address)
///           ARM_PER_TRADE_CAP_WEI       optional
///           ARM_DAILY_BUDGET_WEI        optional
///           ARM_MAX_OPEN_POSITIONS      optional
///           ARM_MAX_SLIPPAGE_BPS        optional
///           ARM_COOLDOWN_SECONDS        optional
///           ARM_MAX_HOLD_SECONDS_HINT   optional
///           ARM_MIN_ORACLE_SCORE        optional
///           ARM_FUND_WEI                optional; ETH sent to the new account in the same run
contract CreateArm is Script {
    function run() external {
        uint256 key = vm.envUint("PRIVATE_KEY");
        HoodArmFactory factory = HoodArmFactory(vm.envAddress("FACTORY"));
        address operator = vm.envAddress("OPERATOR");
        uint256 fund = vm.envOr("ARM_FUND_WEI", uint256(0));

        Policy memory p = factory.defaultPolicy();
        p.perTradeCapWei = uint128(vm.envOr("ARM_PER_TRADE_CAP_WEI", uint256(p.perTradeCapWei)));
        p.dailyBudgetWei = uint128(vm.envOr("ARM_DAILY_BUDGET_WEI", uint256(p.dailyBudgetWei)));
        p.maxOpenPositions = uint16(vm.envOr("ARM_MAX_OPEN_POSITIONS", uint256(p.maxOpenPositions)));
        p.maxSlippageBps = uint16(vm.envOr("ARM_MAX_SLIPPAGE_BPS", uint256(p.maxSlippageBps)));
        p.cooldownSeconds = uint32(vm.envOr("ARM_COOLDOWN_SECONDS", uint256(p.cooldownSeconds)));
        p.maxHoldSecondsHint = uint32(vm.envOr("ARM_MAX_HOLD_SECONDS_HINT", uint256(p.maxHoldSecondsHint)));
        p.minOracleScore = uint8(vm.envOr("ARM_MIN_ORACLE_SCORE", uint256(p.minOracleScore)));

        vm.startBroadcast(key);
        address account = factory.createAccount(operator, p);
        if (fund != 0) {
            (bool ok,) = account.call{value: fund}("");
            require(ok, "fund transfer failed");
        }
        vm.stopBroadcast();

        console.log("owner               ", vm.addr(key));
        console.log("operator            ", operator);
        console.log("HoodArmAccount      ", account);
        console.log("performance fee bps ", HoodArmAccount(payable(account)).performanceFeeBps());
        console.log("per-trade cap wei   ", p.perTradeCapWei);
        console.log("daily budget wei    ", p.dailyBudgetWei);
        console.log("max open positions  ", p.maxOpenPositions);
        console.log("max slippage bps    ", p.maxSlippageBps);
        console.log("cooldown seconds    ", p.cooldownSeconds);
        console.log("min oracle score    ", p.minOracleScore);
        console.log("funded wei          ", fund);
    }
}
