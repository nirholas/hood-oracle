# Contracts: the on-chain arm

Everything in `src/guards/` runs inside one Node process that also holds the
trading key. That is fine until the key is not where it should be. The
contracts in [`contracts/`](../contracts/README.md) put the guards that bound
**new risk** on Robinhood Chain (4663) so the chain enforces them against
whoever holds the key, engine or thief. Commands, deploy and the engine ABI
live in the contracts README; this page is the design and the threat model.

```
owner (cold key) ──funds, policy, kill, withdraw──▶ HoodArmAccount (clone) ──exactInputSingle──▶ SwapRouter02
operator (engine hot key) ──buy inside policy, sell──▶       │                                    │
                                                              │ reads latest(token)                ▼
HoodArmFactory ──creates clones, fee settings──────────────▶  │                              Uniswap v3 pool
HoodOracleAttestations ◀──post(signed score)── oracle ────────┘
HoodFeeSplitter ◀──claimFees──────────────────────────────────┘
```

## The four contracts

### HoodArmAccount

One per owner, deployed by the factory as an EIP-1167 clone. Two roles:

| Role | Key | Can |
|---|---|---|
| `owner` | cold | fund (send ETH; it wraps on demand), `setPolicy`, `applyPolicy`, `cancelPolicy`, `setOperator`, `kill`, `unkill`, `sell`, `ownerWithdraw` (any token or ETH, any time), `sweepDust`, two-step `transferOwnership` |
| `operator` | the engine's `TRADER_PRIVATE_KEY` | `buy` inside the policy, `sell` |
| anyone | | `claimFees` (pushes accrued fees to the protocol recipient) |

`buy(token, amountInWei, amountOutMinimum, fee, deadline)` runs the same
ordered checks as `RiskEngine.check` in `src/guards/risk.ts`, and refuses
with a custom error named after the `RefusalReason`:

| # | Check | Error | Mirrors |
|---|---|---|---|
| 1 | caller is the operator | `NotOperator` | |
| 2 | kill switch off | `KillSwitch` | `kill_switch` |
| 3 | amount non-zero | `ZeroAmount` | `zero_amount` |
| 4 | deadline not passed | `DeadlineExpired` | |
| 5 | token is not the quote token | `QuoteTokenNotTradable` | |
| 6 | cooldown since the last trade elapsed | `Cooldown(remaining)` | `cooldown` |
| 7 | amount within `perTradeCapWei`, cap non-zero | `PerTradeCap(amount, cap)` | `per_trade_cap` |
| 8 | today's spend plus amount within `dailyBudgetWei` (UTC day) | `DailyBudget(wouldSpend, budget)` | `daily_budget` |
| 9 | a free position slot if this token is new | `Concurrency(open, max)` | `concurrency` |
| 10 | fresh attestation at or above `minOracleScore`, when set | `OracleGate(score, min, fresh)` | `oracle_gate` |
| 11 | `amountOutMinimum` within `maxSlippageBps` of the pool's spot output | `SlippageBound(given, required)` | `slippage_bound` |

Then it wraps ETH if the WETH balance is short, records the spend and the
trade time, approves the router for exactly `amountInWei`, calls
`exactInputSingle` with itself as recipient, clears any allowance the router
left, books what actually arrived (balance delta, so a tax token is recorded
at its delivered amount) into a weighted-average cost basis, and emits `Buy`.

`sell(token, amountIn, amountOutMinimum, fee, deadline)` is callable by the
operator or the owner. It is exempt from the kill switch, every cap, the
concurrency limit and the cooldown, for the reason the guardrails doc
gives: a cap that traps a losing position is the failure the stop loss
exists to prevent, and a kill halts new risk only. It still honors the
slippage bound. It releases the sold units' share of the cost basis,
executes, and books realized P&L; a sell updates `lastTradeAt`, so the next
buy waits out the cooldown.

**No `panicSellAll`.** A forced market exit into thin launch liquidity
during whatever caused the panic is usually worse than holding. `kill()`
stops new buys immediately; the owner then closes positions one at a time
with `sell`, at a slippage bound, when they have looked.

**Performance fee.** Each account snapshots the factory's
`performanceFeeBps` at creation. On every sell the position's cumulative
realized P&L is compared with its high-water mark; the fee is charged only
on the part above the mark and the mark moves up. A partial exit at a gain
followed by one at a loss is never charged twice, and a loss is fully
recovered before the next fee. Fees accrue in the quote token inside the
account (`feesAccruedWei`); `ownerWithdraw` of the quote token stops at that
reserve, a buy may not spend it either (a buy only ever uses the quote
balance above it), and the quote token cannot change while any is unclaimed.
`claimFees` pays the factory's current `feeRecipient` and is permissionless,
so clearing that reserve is always one call anybody can make.

**Policy timelock.** `setPolicy` applies at once when the new policy is at
least as tight on every axis (caps, positions, slippage down; cooldown and
oracle floor up; same router and quote token). Any loosening, including a
mixed change, queues for one hour and lands with `applyPolicy`. Rotating
the operator, killing, withdrawing and selling are never delayed.

**Bookkeeping the owner cannot break.** Withdrawing a tracked token shrinks
its position (its basis leaves with it) and closes it at zero, so a slot is
freed and no phantom position lingers. `sweepDust` sends only what the books
do not claim: untracked units of a token, quote above accrued fees, all ETH.

### HoodArmFactory

Creates clones (`createAccount(operator)` with the default template or
`createAccount(operator, policy)`), keeps `accountsOf(owner)`, `isAccount`,
and the global list, and holds the protocol settings:

- `feeRecipient` and `performanceFeeBps` (ceiling 2000 = 20%), changed
  through `proposeFee` / `applyFee` behind a 24-hour timelock, `cancelFee`
  to drop a proposal. A fee change only reaches accounts created after it
  lands: existing accounts keep the bps they were created with.
- `defaultPolicy`, the template `createAccount(operator)` starts from.
- `implementation`, the code new clones point at. **Upgrading it changes
  nothing for existing accounts.** An EIP-1167 clone delegates to the
  address baked into its own bytecode, and there is no proxy admin, no
  beacon and no upgrade hook. An owner who read the code their funds sit
  behind never has it swapped out by a protocol key; the price is that a
  bug fix means creating a new account and moving funds, which the owner
  can do at any time with `ownerWithdraw`.
- `attestations` and `weth` are immutable and are also snapshotted into
  each account at creation, so a later factory cannot repoint an existing
  account's oracle gate.

Protocol ownership is two-step (`Ownable2Step`).

### HoodOracleAttestations

The oracle signs `Attestation{token, score (0..100), tier (Prime..Avoid,
mirroring OracleTier), rugRiskBps, modelVersion, observedAt, expiresAt}`
under EIP-712 (`HoodOracleAttestations`, version `1`, chain id, contract
address). `post(attestation, signature)` is permissionless: it checks the
ranges, that it is not expired, that the signature recovers to the active
signer, and that it is not older than what is stored (monotonic
`observedAt`, so a stale score cannot be replayed over a fresh one). `latest`
returns the stored attestation and whether it is usable; `meets(token,
minScore)` is the one-call form; `verify` and `digest` are for tooling.

Signer changes are asymmetric on purpose. A planned rotation is
`proposeSigner` then `applySigner` after one hour, and the previous signer's
attestations stay valid until they expire. An emergency `revokeSigner` is
immediate, sets the signer to zero so nothing verifies, and bumps
`signerEpoch`, which makes every attestation the revoked key ever posted
read as absent. Tightening now, loosening later.

### HoodFeeSplitter

OpenZeppelin removed `PaymentSplitter` in v5; this is the same audited
pattern with custom errors and a reentrancy guard: fixed payees and shares
at construction, `releasable` / `release` for ETH and for any ERC-20,
pull-based, proportional to `shares / totalShares` of everything ever
received. The deploy script makes it the factory's `feeRecipient`.

## Threat model

| Threat | What happens | What the contracts prevent | What they cannot |
|---|---|---|---|
| **Leaked operator key** | the thief calls `buy` | one buy per cooldown, each at most `perTradeCapWei`, total at most `dailyBudgetWei` per UTC day, at most `maxOpenPositions` tokens, only tokens with a fresh oracle score at or above `minOracleScore`, only through `allowedRouter`, only with a sane `amountOutMinimum`; never a withdrawal; never a policy change. The owner sees `Buy` events, calls `kill()` and `setOperator(newKey)`, and the exposure is bounded by the policy from the first block. | the bounded loss itself: a policy that allows 0.25 ETH a day allows the thief 0.25 ETH a day into a token they control the other side of, until the owner kills. Set the caps as the loss you can accept, not the size you hope to trade. |
| **Leaked owner key** | the thief can withdraw everything | nothing: the owner is the principal. Keep it cold; it is needed only to fund, set policy, kill and withdraw. | |
| **Malicious router** | a router that takes the approval and returns nothing | the account only ever approves `policy.allowedRouter`, exactly `amountIn`, and clears any allowance left behind; switching the router is a policy loosening and waits an hour in the open. Output is measured by balance delta, and a zero delivery reverts (`NothingReceived`). | a legitimate router upgrade needs the owner to set the new address and wait an hour. |
| **Reentrant token** | a token whose transfer hook calls back into the account mid-swap | `buy`, `sell`, `ownerWithdraw`, `sweepDust` and `claimFees` are `nonReentrant`; state (spend, cooldown, basis release) is written before the external swap; a re-entry reverts with `ReentrancyGuardReentrantCall` and the outer call completes on the real balances (tested with a token that re-enters `claimFees`). | a token that simply refuses to transfer traps itself, exactly as it would in any wallet; the owner withdraws whatever it does allow. |
| **Fee-on-transfer token** | a tax token delivers less than the router reports | the position is booked at the delivered amount (balance delta), so cost basis, sells and fees use what the account actually holds. | selling such a token through Uniswap v3 fails at the pool (v3 requires the full input); the engine's firewall blocks these before a live buy, and the owner can `ownerWithdraw` the units. |
| **Sandwich / price manipulation** | the operator (or a thief with the key) passes `amountOutMinimum = 0` | the slippage bound derives a floor from the pool's spot price at execution shaded by `maxSlippageBps`, so a zero minimum reverts. | a same-block manipulation of the spot price by an attacker who also holds the operator key (an EIP-7702 delegated EOA can do this atomically on 4663); the loss is still bounded by the per-trade cap and the daily budget, which is the point of having them. |
| **Oracle signer compromise** | bogus high scores get posted | `revokeSigner` invalidates every attestation the key posted and stops new ones instantly; accounts with `minOracleScore > 0` then refuse every buy (`OracleGate`, fail closed) until a new signer lands after the one-hour rotation. | buys already taken on bogus scores; the per-trade and daily caps bound them. |
| **Protocol owner turns hostile** | raises the fee, swaps the implementation | the fee is capped at 20%, changes wait 24 hours in the open and never touch existing accounts; the implementation change never touches existing accounts; the attestations and WETH addresses are immutable. The one live read is `feeRecipient`, which only redirects fees the protocol already earned. | the protocol could stop honoring new accounts; existing owners are unaffected and can withdraw any time. |
| **Chain / sequencer** | timestamps nudged | timelocks are hours and days, the budget window is a day; a few seconds of drift changes nothing. | |

### Sizing the policy

The policy is the loss budget for a compromised key, not a trading
preference. The earned-autonomy tiers in `guardrails.md` are a good
starting point for both: an arm on probation gets a 0.01 ETH per-trade cap
and a 0.05 ETH daily budget on chain as well as off chain, and the optimizer
never loosens the on-chain policy on its own; the owner does, one hour at a
time, after the off-chain record earned it.

## Gas

From `forge test --gas-report` (unit suite, mock router; optimizer 10k runs,
solc 0.8.28, cancun) and the live-pool fork test. Robinhood Chain floors the
L2 base fee at 0.1 gwei, so a 200k-gas call is 0.00002 ETH on a quiet chain.

| Call | Gas | Notes |
|---|---|---|
| `HoodArmAccount` deploy (implementation, once) | 4,180,775 | 19,117 bytes |
| `HoodArmFactory` deploy | 1,615,190 | |
| `HoodOracleAttestations` deploy | 1,894,811 | |
| `HoodFeeSplitter` deploy | 897,578 | one payee |
| `createAccount` | 404,230 | clone + `initialize` (208,965) |
| `buy`, mock pool | 163,949 median | first buy of a token with ETH wrapping: up to 361,294 |
| `buy`, live WETH/USDG pool | 196,459 median, 332,667 first | real SwapRouter02, includes wrapping |
| `sell`, mock pool | 193,221 median | closing a position refunds storage |
| `sell`, live pool | 235,588 to 258,500 | |
| `setPolicy` | 21,050 median | first queued loosening: 130,525 |
| `kill` / `unkill` | 8,563 / 8,490 | |
| `ownerWithdraw` | 33,808 median | |
| `claimFees` | 30,866 median | 61,555 on the live pool run |
| `post` (attestation) | 47,777 median | first attestation for a token: 87,577 |
| `latest` / `meets` | about 10k | what a `buy` pays for the oracle gate |
| `release(address)` | 92,573 median | ETH release from the splitter |

## Deployment

Not deployed yet. `forge script script/Deploy.s.sol --rpc-url robinhood
--broadcast --verify --verifier blockscout --verifier-url
https://robinhoodchain.blockscout.com/api` prints the block below with real
addresses; paste it here and commit
`contracts/broadcast/Deploy.s.sol/4663/run-latest.json` with it.

```
  chain id               4663
  deployer / owner       (from PRIVATE_KEY)
  HoodArmAccount impl    (printed by the script)
  HoodOracleAttestations (printed by the script)
  HoodFeeSplitter        (printed by the script)
  HoodArmFactory         (printed by the script)
  oracle signer          (ORACLE_SIGNER)
  performance fee bps    (PERFORMANCE_FEE_BPS)
  router                 0xCaf681a66D020601342297493863E78C959E5cb2
  weth                   0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
```

## Verification record

Unit and fuzz: 103 tests across `HoodArmAccount`, `HoodArmFactory`,
`HoodOracleAttestations`, `HoodFeeSplitter` and the policy maths, including
fuzzed properties for the tighter-or-equal ordering, the UTC-day index, the
spot-price round trip, the high-water-mark fee over random sell sequences,
the caps under random sizing, and the exact slippage floor. Fork: 5 tests on
a fork of 4663 through the real SwapRouter02, QuoterV2 and the WETH/USDG
0.05% pool. Coverage on `contracts/src`: 100% of lines in every file
(`forge coverage --no-match-contract Fork --report summary`).

## Related

- [`contracts/README.md`](../contracts/README.md): build, test, deploy, verify, the engine ABI
- [guardrails.md](guardrails.md): the off-chain checks these mirror, and why sells are exempt
- [arming.md](arming.md): how an arm goes live
- [oracle.md](oracle.md): where the attested scores come from
