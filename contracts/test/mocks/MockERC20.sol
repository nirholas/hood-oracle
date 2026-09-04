// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Plain mintable ERC-20 for unit tests: the launch token side of a pool.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @dev Takes `feeBps` of every transfer and burns it, the way tax tokens do.
///      The arm books what actually arrives, so a buy of such a token records
///      the post-tax amount and a sell of it fails on a real Uniswap v3 pool.
contract FeeOnTransferToken is MockERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) MockERC20("Tax", "TAX", 18) {
        feeBps = feeBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = (value * feeBps) / 10_000;
            super._update(from, address(0), tax);
            super._update(from, to, value - tax);
            return;
        }
        super._update(from, to, value);
    }
}

/// @dev Calls back into `target` on every transfer it receives, the way a
///      malicious token would try to re-enter `buy` or `sell` mid-swap.
contract ReentrantToken is MockERC20 {
    address public target;
    bytes public payload;
    bool public reentered;
    bytes public lastError;

    constructor() MockERC20("Reenter", "RE", 18) {}

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == target && target != address(0) && payload.length != 0 && !reentered) {
            reentered = true;
            (bool ok, bytes memory err) = target.call(payload);
            if (!ok) lastError = err;
        }
    }
}
