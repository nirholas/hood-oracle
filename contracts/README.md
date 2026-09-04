# hood-oracle contracts: the on-chain arm

The guardrails the engine enforces in `src/guards/risk.ts` exist off chain,
inside one process that holds the trading key. If that key leaks, nothing
stops the thief from ignoring every cap. This directory moves the caps that
bound **new risk** onto Robinhood Chain (4663) itself: a per-owner account
contract holds the funds, the engine's hot key is only an *operator* that can
`buy` inside the owner's policy and `sell`, and the owner keeps the kill
switch, the policy and unrestricted withdrawal. A leaked operator key can at
worst take one policy-sized trade per cooldown until the daily budget is gone,
into a token with a fresh oracle score, at no worse than the policy's slippage.

Design, threat model and gas figures: [`docs/contracts.md`](../docs/contracts.md).

## Layout

```
contracts/
  foundry.toml                 profiles default + ci, rpc + Blockscout verifier for 4663
  soldeer.lock                 pinned dependencies (OpenZeppelin 5.4.0, forge-std 1.10.0)
  src/
    HoodArmAccount.sol         one owner's arm (EIP-1167 clone): policy, kill, buy, sell, fees
    HoodArmFactory.sol         creates accounts, owner registry, protocol fee (24h timelock)
    HoodOracleAttestations.sol EIP-712 oracle scores on chain; the on-chain oracle gate
    HoodFeeSplitter.sol        pull-payment splitter for protocol fees (ETH + ERC-20)
    interfaces/                IHoodArmAccount, IHoodArmFactory, IHoodOracleAttestations,
                               IHoodFeeSplitter, ISwapRouter02, IWETH9, IUniswapV3
    libraries/                 HoodErrors (custom errors), PolicyLib, PositionLib, SpotPriceLib
  test/                        unit + fuzz (mock router) and Fork.t.sol (live 4663)
  script/                      Deploy.s.sol, CreateArm.s.sol
```

## Prerequisites

Foundry 1.7 or newer (`curl -L https://foundry.paradigm.xyz | bash` then
`foundryup`). Dependencies are managed by soldeer and live in
`contracts/dependencies/`, which is gitignored; restore them once per clone:

```sh
cd contracts
forge soldeer install
```

That reads `[dependencies]` in `foundry.toml` and the checksums in
`soldeer.lock`, so every machine builds against byte-identical
OpenZeppelin 5.4.0 and forge-std 1.10.0.

## Build and test

All commands run from `contracts/` (or from the repo root with
`--root contracts`; `npm run contracts:build` and `npm run contracts:test`
do exactly that).

```sh
forge build                                 # solc 0.8.28, optimizer on, cancun
forge test                                  # everything, incl. the fork test (needs network)
forge test --no-match-contract Fork         # offline: unit + fuzz, about a second
forge test --match-contract Fork -vv        # only the live-chain test
forge test --fork-url robinhood --match-contract Fork   # same, explicit fork
FOUNDRY_PROFILE=ci forge test               # offline, 2048 fuzz runs per property
forge coverage --no-match-contract Fork --report summary
forge test --no-match-contract Fork --gas-report
forge fmt --check
```

The fork test (`test/Fork.t.sol`, contract `HoodArmForkTest`) forks
`rpc_endpoints.robinhood` on its own when it is not already on chain 4663,
deploys the factory, creates an account, funds it, buys USDG with WETH
through the real SwapRouter02 and the live WETH/USDG 0.05% pool, sells it
back, moves the pool with a whale swap to realize a profit, and asserts the
events, the cost basis, the performance fee and `claimFees`. The `ci`
profile sets `no_match_contract = "Fork"` so a network-less runner never
sees it.

## Deploy to Robinhood Chain

```sh
cd contracts
export PRIVATE_KEY=0x...            # deployer; becomes the protocol owner
export FEE_RECIPIENT=0x...          # first splitter payee (100% unless SPLITTER_* is set)
export ORACLE_SIGNER=0x...          # the address the oracle signs attestations with
export PERFORMANCE_FEE_BPS=1000     # 10%, ceiling is 2000

forge script script/Deploy.s.sol \
  --rpc-url robinhood --broadcast \
  --verify --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api
```

Optional environment: `SPLITTER_PAYEES` / `SPLITTER_SHARES` (comma-separated,
same length), `ROUTER` and `WETH` overrides (default to the 4663 mainnet
addresses), and `DEFAULT_PER_TRADE_CAP_WEI`, `DEFAULT_DAILY_BUDGET_WEI`,
`DEFAULT_MAX_OPEN_POSITIONS`, `DEFAULT_MAX_SLIPPAGE_BPS`,
`DEFAULT_COOLDOWN_SECONDS`, `DEFAULT_MAX_HOLD_SECONDS_HINT`,
`DEFAULT_MIN_ORACLE_SCORE` for the factory's default policy template
(defaults: 0.01 ETH, 0.05 ETH, 1, 1000 bps, 30 s, 3600 s, 0).

The script prints one line per address. Keep the output; the engine and the
dashboard need `HoodArmFactory` and `HoodOracleAttestations`:

```
  chain id               4663
  deployer / owner       0x...
  HoodArmAccount impl    0x...
  HoodOracleAttestations 0x...
  HoodFeeSplitter        0x...
  HoodArmFactory         0x...
  oracle signer          0x...
  performance fee bps    1000
  router                 0xCaf681a66D020601342297493863E78C959E5cb2
  weth                   0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
```

The broadcast receipts land in `contracts/broadcast/Deploy.s.sol/4663/`;
commit `run-latest.json`, it is the deployment record.

### Verify separately

If `--verify` did not land (the Blockscout API sits behind a Cloudflare
challenge that sometimes answers automated clients with 403; retry from
another network or later), verify each contract by hand. Constructor
arguments must match what the script used:

```sh
forge verify-contract --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  --chain 4663 <HoodArmAccount impl> src/HoodArmAccount.sol:HoodArmAccount

forge verify-contract --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  --chain 4663 <HoodOracleAttestations> src/HoodOracleAttestations.sol:HoodOracleAttestations \
  --constructor-args $(cast abi-encode "constructor(address,address)" <owner> <ORACLE_SIGNER>)

forge verify-contract --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  --chain 4663 <HoodFeeSplitter> src/HoodFeeSplitter.sol:HoodFeeSplitter \
  --constructor-args $(cast abi-encode "constructor(address[],uint256[])" "[<FEE_RECIPIENT>]" "[1]")

forge verify-contract --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  --chain 4663 <HoodArmFactory> src/HoodArmFactory.sol:HoodArmFactory \
  --constructor-args $(cast abi-encode \
    "constructor(address,address,address,address,address,uint16,(uint128,uint128,uint16,uint16,uint32,uint32,uint8,address,address))" \
    <owner> <impl> <attestations> 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 <splitter> 1000 \
    "(10000000000000000,50000000000000000,1,1000,30,3600,0,0xCaf681a66D020601342297493863E78C959E5cb2,0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73)")
```

Accounts are EIP-1167 clones of the verified implementation; Blockscout
resolves them automatically once the implementation is verified.

## Create an arm

The owner key creates the account and sets its policy; the operator is the
engine's hot key (the address of `TRADER_PRIVATE_KEY` in `.env`).

```sh
cd contracts
export PRIVATE_KEY=0x...            # the OWNER (cold key), not the engine key
export FACTORY=0x...                # from the deploy output
export OPERATOR=0x...               # address of TRADER_PRIVATE_KEY
export ARM_PER_TRADE_CAP_WEI=50000000000000000      # 0.05 ETH
export ARM_DAILY_BUDGET_WEI=250000000000000000      # 0.25 ETH
export ARM_MAX_OPEN_POSITIONS=3
export ARM_MAX_SLIPPAGE_BPS=1000
export ARM_COOLDOWN_SECONDS=30
export ARM_MIN_ORACLE_SCORE=56                      # 0 disables the on-chain oracle gate
export ARM_FUND_WEI=500000000000000000              # optional: send 0.5 ETH in the same run

forge script script/CreateArm.s.sol --rpc-url robinhood --broadcast
```

Unset `ARM_*` values fall back to the factory's default template. The
account accepts plain ETH transfers at any time and wraps to WETH on demand
when a buy needs it. Everything else the owner does is a direct call:

```sh
cast send <account> "kill()" --rpc-url robinhood --private-key $PRIVATE_KEY
cast send <account> "unkill()" ...
cast send <account> "setOperator(address)" <newHotKey> ...
cast send <account> "ownerWithdraw(address,uint256,address)" 0x0000000000000000000000000000000000000000 <wei> <to> ...
cast send <account> "sell(address,uint256,uint256,uint24,uint256)" <token> <amountIn> <minOut> <fee> <deadline> ...
cast call <account> "policy()((uint128,uint128,uint16,uint16,uint32,uint32,uint8,address,address))" --rpc-url robinhood
cast call <account> "position(address)((uint128,uint128,int128,int128,uint64))" <token> --rpc-url robinhood
```

Policy changes: `setPolicy(Policy)` applies immediately when every field is
at least as tight as today (smaller caps, fewer positions, less slippage,
longer cooldown, higher oracle floor) and otherwise queues for one hour;
`applyPolicy()` lands it, `cancelPolicy()` drops it. The quote token cannot
change while positions are open.

## How the engine uses it

The engine's executor (`src/engine/executor.ts`) currently signs swaps from
the hot key's own wallet. The `armAccount` execution path that lands next
sends the same swap through the account instead: the hot key becomes the
account's operator, holds only gas, and the funds sit in the account. The
ABI that path needs, all on `HoodArmAccount`:

```solidity
// operator only
function buy(address token, uint256 amountInWei, uint256 amountOutMinimum, uint24 fee, uint256 deadline)
    external returns (uint256 amountOut);
// operator or owner; exempt from kill, caps and cooldown; still slippage-bounded
function sell(address token, uint256 amountIn, uint256 amountOutMinimum, uint24 fee, uint256 deadline)
    external returns (uint256 proceedsWei);

// pre-flight reads (mirror RiskEngine.check so the engine refuses locally before paying gas)
function killed() external view returns (bool);
function policy() external view returns (Policy memory);          // caps, cooldown, slippage, minOracleScore, router, quote
function spentTodayWei() external view returns (uint256);
function remainingDailyBudgetWei() external view returns (uint256);
function cooldownRemaining() external view returns (uint256);
function openPositionCount() external view returns (uint256);
function position(address token) external view returns (Position memory); // tokenAmount, costBasisWei, realizedNetWei, feeHighWaterWei, openedAt
function withdrawableQuoteWei() external view returns (uint256);

// events the positions sweep reconciles from
event Buy(address indexed token, uint256 amountInWei, uint256 amountOut, uint24 fee, uint256 positionTokenAmount, uint256 positionCostBasisWei);
event Sell(address indexed token, uint256 amountIn, uint256 proceedsWei, uint24 fee, int256 realizedWei, uint256 feeWei, address indexed by);
event PositionClosed(address indexed token, int256 realizedNetWei);
```

`amountOutMinimum` must be at least the pool's fee-adjusted spot output
shaded by `policy.maxSlippageBps` (the account computes the floor from
`slot0` of the pool the router's factory returns for `(quote, token, fee)`),
so the engine keeps quoting through QuoterV2 and passes its own shaded
quote as it does today; the on-chain bound only bites when a quote is
missing or wrong. `fee` is the Uniswap v3 tier of the pool the launch trades
on (NOXA and instant launches use 10000). Odyssey curve venues are not
routable through the account: the arm is a Uniswap v3 surface, and curve
positions stay on the hot key's own wallet until they graduate.

Every refusal is a custom error whose name is the `RefusalReason` the engine
already journals (`src/libraries/HoodErrors.sol`): `KillSwitch()`,
`PerTradeCap(amount, cap)`, `DailyBudget(wouldSpend, budget)`,
`Concurrency(open, max)`, `Cooldown(remainingSeconds)`,
`SlippageBound(amountOutMinimum, required)`, `OracleGate(score, minScore, fresh)`,
`NotOperator(caller)`, `ZeroAmount()`, `DeadlineExpired(deadline, now)`.
`viem`'s `decodeErrorResult` against the account ABI (`out/HoodArmAccount.sol/HoodArmAccount.json`)
turns a revert into the reason string the dashboard shows.

The oracle gate reads `HoodOracleAttestations.latest(token)`. The oracle
signs `Attestation{token, score, tier, rugRiskBps, modelVersion, observedAt,
expiresAt}` under the EIP-712 domain `HoodOracleAttestations` / `1` /
chain 4663 / the contract address, and any caller can `post` it; the account
refuses a buy with `OracleGate` when `policy.minOracleScore > 0` and there is
no fresh attestation at or above it.
