# Multi-tenant: trade from your own account

Everything else in hood-oracle assumes one operator with one hot wallet. This
page is about the other shape: many owners, each funding their own on-chain
account, all operated by the same engine, none of them trusting it with
custody.

The rule the whole design serves: **the engine can trade your funds and can
never take them.** It holds an operator key that the contract lets call `buy`
and `sell` inside bounds you wrote on chain. Withdrawal, policy changes,
operator rotation and the kill switch belong to the wallet that created the
account, and to nothing else.

## The pieces

| Piece | Where | What it does |
|---|---|---|
| `HoodArmAccount` | [contracts/src/HoodArmAccount.sol](https://github.com/nirholas/hood-oracle/blob/main/contracts/src/HoodArmAccount.sol) | Holds one owner's funds and enforces the policy on every swap |
| `HoodArmFactory` | [contracts/src/HoodArmFactory.sol](https://github.com/nirholas/hood-oracle/blob/main/contracts/src/HoodArmFactory.sol) | Clones accounts (EIP-1167) and publishes the default policy |
| `src/accounts/siwe.ts` | server | EIP-4361 parsing and validation, positional and strict |
| `src/accounts/session.ts` | server | Sign-in sessions; the browser holds an opaque HttpOnly cookie |
| `src/accounts/registry.ts` | server | Discovers accounts from the factory, caches chain state, flips an account to `revoked` the moment it stops naming us operator |
| `src/engine/account-executor.ts` | server | The execution path that routes a buy or a sell through an account instead of the hot wallet |
| `/app/connect` | dashboard | Connect, sign in, deploy an account, change its policy |

Full contract detail, including the threat model and gas, is in
[contracts.md](contracts.md). This page is the operator's and the user's view.

## The walk

### 1. Sign in

`GET /api/auth/nonce` issues a single-use nonce bound to a pre-auth cookie.
The browser builds an EIP-4361 message with it and asks the wallet to
`personal_sign`. `POST /api/auth/verify` burns the nonce, parses the message
positionally (a lenient parser that greps for `Nonce:` accepts a message whose
statement smuggles a second one), checks domain, URI host, chain id, nonce and
freshness, then verifies the signature. EOA signatures verify directly;
contract wallets verify through EIP-1271.

What comes back is a session cookie. Only the SHA-256 of its secret is stored,
so a database leak cannot be replayed as a login.

```bash
curl -s -c jar.txt https://hood-oracle.example/api/auth/nonce
# sign the message in a wallet, then
curl -s -b jar.txt -X POST https://hood-oracle.example/api/auth/verify \
  -H 'content-type: application/json' \
  -d '{"message":"<the exact string you signed>","signature":"0x…"}'
```

The signature proves an address. It moves no funds and approves no
transaction: there is no `eth_sendTransaction` anywhere in sign-in.

### 2. Deploy an account

`POST /api/accounts/prepare` builds the factory call and hands back **unsigned**
calldata plus the policy it encodes. The server has no owner key, so every
account is deployed by the owner's own wallet:

```bash
curl -s -b jar.txt -X POST https://hood-oracle.example/api/accounts/prepare \
  -H 'content-type: application/json' \
  -d '{"policy":{"perTradeCapWei":"10000000000000000","dailyBudgetWei":"100000000000000000"}}'
```

```json
{
  "tx": {
    "to": "0x…factory",
    "data": "0x…",
    "value": "0",
    "chainId": 4663,
    "summary": "Create a hood-oracle arm account with a 0.01 ETH per-trade cap and a 0.1 ETH daily budget, operated by 0x…"
  },
  "policy": { "perTradeCapWei": "10000000000000000", "…": "…" },
  "note": "Sign this from 0x…: that address becomes the account's owner…"
}
```

Send it, then `POST /api/accounts/register` with the transaction hash. The
server reads the receipt, decodes `AccountCreated`, checks that the owner in
the event is the signed-in address, and caches the account. A hash that
created someone else's account, or created nothing, is refused.

### 3. Fund it

Send ETH to the account address. The operator wraps what it needs per trade;
the owner withdraws with `ownerWithdraw(token, amount, to)` at any time,
killed or not, mid-position or not.

### 4. Point an arm at it

Every arm carries an `accountId`. Null means the legacy arm that trades the
server's own wallet and needs the operator token. Set it, and that arm's buys
and sells go through the account:

```bash
curl -s -b jar.txt -X POST https://hood-oracle.example/api/arms \
  -H 'content-type: application/json' \
  -d '{"label":"prime only","accountId":"…","perTradeWei":"5000000000000000","stopLossPct":40}'
```

On the dashboard this is the **Funding source** select on
[/app/arm](/app/arm). An arm created by a wallet session must name an account:
a session cannot create an arm on the server's wallet, and the operator token
cannot be replaced by a signature.

Arm settings are **clamped to the account's policy** on write. Ask for a
per-trade size above the on-chain cap and the response tells you what it was
reduced to and why, rather than letting the chain reject every fill later.

## What the engine may do

`buy` is `onlyOperator` and checks, in the contract:

- the per-trade cap and the daily budget
- the cooldown since the last buy
- the open-position count
- the oracle gate, when `minOracleScore > 0`: a fresh EIP-712 attestation from
  `HoodOracleAttestations` scoring at least that high
- the slippage bound against the quoted amount out
- that the router is the one the policy allows

Two details worth knowing before you size a policy:

- **The on-chain daily budget resets at 00:00 UTC**, because the contract
  measures it by UTC day (`PolicyLib.dayIndex`). The arm's own
  `dailyBudgetWei` off chain is a true rolling 24h window. They are both
  ceilings and the tighter one always wins, but they are not the same window,
  so an arm that spent its budget at 23:00 gets a fresh on-chain allowance an
  hour later.
- **Accrued performance fees are not trading capital.** A buy may only spend
  the quote balance above `feesAccruedWei`, so `claimFees()` is always payable
  and `withdrawableQuoteWei()` never reads zero because the operator spent
  money the protocol was already owed. For the same reason the quote token
  cannot change while fees are unclaimed; `claimFees()` is permissionless, so
  anyone can clear that in one call.

`sell` is callable by the owner or the operator and is **exempt from the spend
caps**, on chain as well as off. A cap that traps a losing position is the
failure a stop loss exists to prevent.

Nothing else is callable by the operator. There is no operator path to
`ownerWithdraw`, no proxy upgrade, no delegatecall.

Every buy is **pre-flighted** with an `eth_call` of the exact account call
before anything is signed, so a policy refusal is journaled as
`per_trade_cap` or `cooldown` rather than as a paid-for `execution reverted`.

## What the owner keeps

| Action | Who | Timing |
|---|---|---|
| `ownerWithdraw` | owner | immediate, always, including while killed |
| `setPolicy` tightening every field | owner | immediate |
| `setPolicy` loosening any field | owner | queued 1 hour, then `applyPolicy()` |
| `cancelPolicy` | owner | immediate |
| `setOperator` | owner | immediate |
| `kill` / `unkill` | owner | immediate |
| `transferOwnership` + `acceptOwnership` | owner then heir | two steps |

The one-hour timelock on loosening is the point of the design: a stolen owner
key cannot widen the caps and drain the account inside one block, and the
owner has an hour to `cancelPolicy` and rotate. Tightening never waits,
because the answer to "something is wrong" must never be "wait an hour".

## Revocation

The registry re-reads every active account on a 60s sweep. The moment an
account's `operator` is no longer this engine's key:

1. the row flips to `revoked` with the reason,
2. every arm bound to it is disarmed,
3. `account_revoked` and `arm_disarmed_account_revoked` land in the decision
   journal,
4. further buys refuse with `operator_revoked` before they reach the chain.

Rotating the operator away is therefore a complete, unilateral exit. It needs
no cooperation from the server and no support ticket.

Open positions are the one thing rotation does not close: the engine can no
longer sell them, so the owner sells or withdraws the tokens directly.
Rotate deliberately, with the ladder in mind.

## Operating one of these servers

Set these on the service:

| Variable | Meaning |
|---|---|
| `HOOD_ARM_FACTORY` | the deployed `HoodArmFactory`; without it the accounts API answers 503 and the engine runs single-tenant |
| `TRADER_PRIVATE_KEY` | the operator key. Users grant it operator rights; it never holds their funds |
| `SESSION_SECRET` | keys the session cookies. Unset means a random one per boot, which logs everybody out on deploy |
| `SIWE_DOMAINS` | domains a sign-in message may claim. Empty means the request's own host |

The operator key still needs ETH, for gas only. `OPERATOR_GAS_FLOOR_WEI` in
[account-executor.ts](https://github.com/nirholas/hood-oracle/blob/main/src/engine/account-executor.ts)
is the floor it refuses to trade below.

The operator token remains the admin path: it can read and write any account's
arms, which is how support and the MCP tools reach a user's arm. It cannot
withdraw from an account either.

## Limits, stated plainly

- **v3 only.** The account's `buy` calls `exactInputSingle` on the policy's
  router. Uniswap v4 pools and Odyssey curve positions stay on the hot wallet's
  own path and this executor refuses them with `no_route` rather than
  pretending to route them.
- **One chain per server.** Accounts are keyed by `(address, chainId)` and the
  session carries a chain id; a server trades the chain it is configured for.
- **The performance fee is a contract-level high-water mark.** It cannot be
  charged twice on the same gain, and the protocol ceiling is 20% with its own
  24h timelock. See [litepaper.md](litepaper.md).

## Related

- [contracts.md](contracts.md): every contract, function by function, plus the threat model
- [guardrails.md](guardrails.md): the off-chain checks that run before the on-chain ones
- [arming.md](arming.md): simulate, read the ledger, go live
- [api.md](api.md): every route, including `/api/auth` and `/api/accounts`
