// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHoodArmAccount} from "../interfaces/IHoodArmAccount.sol";

/// @title PositionLib
/// @notice Weighted-average cost basis and the high-water-mark performance
///         fee. The fee is charged only on realized profit that lifts the
///         position's cumulative realized P&L above its previous high, so a
///         partial exit at a gain followed by a partial exit at a loss is
///         never charged twice, and a loss is fully recovered before the next
///         fee is due.
library PositionLib {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant BPS = 10_000;

    /// @notice Fold a fill of `received` units bought for `spentWei` into the position.
    function recordBuy(IHoodArmAccount.Position storage p, uint256 received, uint256 spentWei, uint64 now_) internal {
        if (p.tokenAmount == 0) p.openedAt = now_;
        p.tokenAmount = (uint256(p.tokenAmount) + received).toUint128();
        p.costBasisWei = (uint256(p.costBasisWei) + spentWei).toUint128();
    }

    /// @notice Remove `amountIn` units from the position and return the cost
    ///         basis they carried (weighted average). Does not touch P&L.
    function releaseBasis(IHoodArmAccount.Position storage p, uint256 amountIn) internal returns (uint256 basisWei) {
        uint256 held = p.tokenAmount;
        basisWei = Math.mulDiv(p.costBasisWei, amountIn, held);
        p.tokenAmount = (held - amountIn).toUint128();
        p.costBasisWei = (uint256(p.costBasisWei) - basisWei).toUint128();
    }

    /// @notice Book `proceedsWei` against `basisWei` and return the realized
    ///         P&L of this sell and the fee due under the high-water mark.
    function recordSell(IHoodArmAccount.Position storage p, uint256 proceedsWei, uint256 basisWei, uint16 feeBps)
        internal
        returns (int256 realizedWei, uint256 feeWei)
    {
        realizedWei = proceedsWei.toInt256() - basisWei.toInt256();
        int256 net = int256(p.realizedNetWei) + realizedWei;
        p.realizedNetWei = net.toInt128();
        feeWei = feeAbove(net, p.feeHighWaterWei, feeBps);
        if (feeWei != 0) p.feeHighWaterWei = net.toInt128();
    }

    /// @notice Pure high-water-mark fee: `feeBps` of the part of `net` above `highWater`, if any.
    function feeAbove(int256 net, int256 highWater, uint16 feeBps) internal pure returns (uint256) {
        if (feeBps == 0 || net <= highWater) return 0;
        // casting to 'uint256' is safe because net > highWater was checked just above
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 newProfit = uint256(net - highWater);
        return Math.mulDiv(newProfit, feeBps, BPS);
    }
}
