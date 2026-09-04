/**
 * Pay-per-score over x402 on Robinhood Chain. hood402 is the rail: USDG,
 * the `exact` scheme over EIP-3009 transferWithAuthorization, settled by a
 * facilitator so this process never holds a gas key for payments.
 *
 *   GET /api/x402/pricing        free: what the paid route costs and how to pay
 *   GET /api/x402/score/:token   paid: the latest verdict, features and firewall
 *
 * Order of checks on the paid route matters: configuration (503) and
 * existence (404) are answered before the paywall, so nobody pays for a
 * token that was never scored. Only a scored token reaches the 402.
 */
import { Hono } from 'hono'
import { and, desc, eq, sql } from 'drizzle-orm'
import { PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER, REASON_TEXT, buildPaymentRequired, requireNetwork } from 'hood402'
import { PaywallEngine } from 'hood402/server'
import { schema } from '../../db/client.js'
import type { AppDeps } from '../deps.js'
import { respond } from '../json.js'
import { ApiError } from '../errors.js'
import { parseAddress } from '../query.js'
import { rowToFirewall, rowToScore, rowToSnapshot } from '../serialize.js'
import { publicUrl } from '../middleware/client-ip.js'
import type { Wire, X402PricingResponse } from '../contract.js'
import type { Network } from '../../types.js'

export const X402_SCORE_PATH = '/api/x402/score/:token'

/** hood402 network id for our HOOD_NETWORK. */
export function x402NetworkId(network: Network): string {
  return network === 'mainnet' ? 'robinhood' : 'robinhood-testnet'
}

const DESCRIPTION = 'hood-oracle conviction verdict for one Robinhood Chain launch: score, tier, rug risk, per-head probabilities, the 90-second feature snapshot and the latest firewall round trip.'

function unconfigured(): ApiError {
  return new ApiError(
    503,
    'x402_not_configured',
    'The operator has not configured a pay-to address for paid scores: set X402_PAY_TO on the server to enable GET /api/x402/score/:token. The free feed at GET /api/oracle/feed and GET /api/oracle/coin/:token is unaffected.',
  )
}

export function x402Routes(deps: AppDeps): Hono {
  const app = new Hono()
  const { config, db, log } = deps

  /** A verify/settle round trip that could not reach the facilitator is the operator's problem to fix, and the buyer is told so. */
  async function facilitatorCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ facilitator: config.x402.facilitatorUrl, err: message }, 'x402 facilitator call failed')
      throw new ApiError(
        502,
        'facilitator_unreachable',
        `The x402 facilitator at ${config.x402.facilitatorUrl} could not verify or settle the payment (${message}). Nothing was charged. The operator can point X402_FACILITATOR_URL at a reachable hood402 facilitator; the free routes are unaffected.`,
      )
    }
  }
  const net = requireNetwork(x402NetworkId(config.network))
  const payTo = config.x402.payTo
  const paywall = payTo
    ? new PaywallEngine({
        price: config.x402.scorePriceUsdg,
        payTo,
        network: net.id,
        facilitator: config.x402.facilitatorUrl,
        description: DESCRIPTION,
      })
    : null

  app.get('/pricing', (c) => {
    const base = new URL(publicUrl(c, config.trustProxy))
    const body: X402PricingResponse = {
      enabled: paywall != null,
      resource: `${base.origin}${X402_SCORE_PATH}`,
      method: 'GET',
      price: { usdg: config.x402.scorePriceUsdg, atomic: (BigInt(Math.round(Number(config.x402.scorePriceUsdg) * 10 ** net.usdgDecimals))).toString(), decimals: net.usdgDecimals },
      network: { id: net.id, chainId: net.chainId },
      asset: { symbol: 'USDG', address: net.usdg, eip712: { name: net.usdgDomain.name, version: net.usdgDomain.version } },
      scheme: 'exact',
      x402Version: 1,
      payTo: payTo ?? null,
      facilitator: config.x402.facilitatorUrl,
      description: DESCRIPTION,
      freeAlternative: `${base.origin}/api/oracle/feed`,
      howToPay:
        'GET the resource; a 402 carries `accepts[]`. Sign an EIP-3009 TransferWithAuthorization for `maxAmountRequired` USDG to `payTo` on chain 4663 and retry with the base64 payload in the X-PAYMENT header. hood402/client and @hood-oracle/sdk do this for you.',
    }
    return respond(c, body)
  })

  app.get('/score/:token', async (c) => {
    if (!paywall) throw unconfigured()
    const token = parseAddress(c.req.param('token'))
    const network = config.network
    const tokenMatch = sql`lower(${schema.oracleScores.token}) = ${token}`
    const [latest] = await db
      .select()
      .from(schema.oracleScores)
      .where(and(tokenMatch, eq(schema.oracleScores.network, network)))
      .orderBy(desc(schema.oracleScores.scoredAt))
      .limit(1)
    if (!latest) {
      throw new ApiError(
        404,
        'not_scored',
        `${token} has no oracle verdict yet. Every launch is scored about 90 seconds after first sight; watch it arrive for free on GET /api/oracle/stream or list scored launches on GET /api/oracle/feed.`,
      )
    }
    // The paywall. `resource` is the URL as the buyer sees it (https behind Cloud Run).
    const resource = publicUrl(c, config.trustProxy)
    const auth = await facilitatorCall(() => paywall.authorize(c.req.header(PAYMENT_HEADER), resource))
    if (!auth.ok) return c.json(auth.body, 402)
    const settlement = await facilitatorCall(() => paywall.settle(auth.payload, auth.requirements))
    if (!settlement.success) {
      log.warn({ token, reason: settlement.errorReason ?? null }, 'x402 settlement failed')
      return c.json(buildPaymentRequired(auth.requirements, settlement.errorReason ? REASON_TEXT[settlement.errorReason] : 'Settlement failed'), 402)
    }
    c.header(PAYMENT_RESPONSE_HEADER, paywall.settlementHeader(settlement))
    const exact = latest.token
    const [featureRows, firewallRows, [count]] = await Promise.all([
      db.select().from(schema.launchFeatures).where(and(eq(schema.launchFeatures.token, exact), eq(schema.launchFeatures.network, network))).limit(1),
      db.select().from(schema.firewallDecisions).where(and(eq(schema.firewallDecisions.token, exact), eq(schema.firewallDecisions.network, network))).orderBy(desc(schema.firewallDecisions.at)).limit(1),
      db.execute(sql`select count(*)::int as n from oracle_scores where token = ${exact} and network = ${network}`) as unknown as Promise<{ n: number }[]>,
    ])
    log.info({ token, payer: auth.payload.payload.authorization.from, tx: settlement.transaction ?? null }, 'x402 score sold')
    const body = {
      token: exact,
      verdict: rowToScore(latest),
      features: featureRows[0] ? rowToSnapshot(featureRows[0]) : null,
      firewall: firewallRows[0] ? rowToFirewall(firewallRows[0]) : null,
      history: Number(count?.n ?? 1),
      paidAt: new Date().toISOString(),
    }
    return respond(c, body as unknown as Wire<typeof body>)
  })

  return app
}
