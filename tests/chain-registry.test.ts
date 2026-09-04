import { describe, expect, it } from 'vitest'
import { toFunctionSelector, type Address, type Hex } from 'viem'
import { MAINNET_ADDRESSES, NOXA_ADDRESSES } from 'hoodchain'
import { ALL_LAUNCHPADS, LAUNCHPAD_REGISTRY, UNISWAP_V4, launchpadEntry, launchpadNameFor, matchesLaunchSignal } from '../src/chain/launchpads.js'
import { arms } from '../src/db/schema.js'

describe('launchpad registry', () => {
  it('has unique addresses and a kind for every entry', () => {
    const seen = new Set<string>()
    for (const e of LAUNCHPAD_REGISTRY) {
      expect(seen.has(e.address.toLowerCase()), e.address).toBe(false)
      seen.add(e.address.toLowerCase())
      expect(['launchpad', 'position-manager', 'router', 'unknown']).toContain(e.kind)
      if (e.kind !== 'launchpad') expect(e.name).toBe('direct')
    }
  })
  it('names launches by creating contract, then by v4 hook, then direct', () => {
    expect(launchpadNameFor(NOXA_ADDRESSES.launchFactory)).toBe('noxa')
    expect(launchpadNameFor('0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75')).toBe('pons')
    expect(launchpadNameFor('0x4a3e797b2e4dd1cf96b352513ea91b2f6449e74a')).toBe('launcher-4a3e797b')
    expect(launchpadNameFor(MAINNET_ADDRESSES.nonfungiblePositionManager)).toBe('direct')
    expect(launchpadNameFor(UNISWAP_V4.positionManager, '0xf7521cf0bb7c11e2d2794189412614cf2e29a0cc')).toBe('lunch')
    expect(launchpadNameFor(UNISWAP_V4.positionManager, '0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc')).toBe('rwa-launchpad')
    expect(launchpadNameFor('0x1111111111111111111111111111111111111111' as Address)).toBe('direct')
    expect(launchpadNameFor(null)).toBe('direct')
  })
  it('matches feed transactions by selector on selector-bearing entries and by address on the rest', () => {
    const pons = '0xf4fc0cd27fc8ecf17e55ee4c3f7201897df3eb75' as Address
    const launchToken = toFunctionSelector('function launchToken((string,string,string,string,(string,string,string,string,string),address),uint256,uint256,bytes32)')
    expect(matchesLaunchSignal(pons, `${launchToken}00` as Hex)?.name).toBe('pons')
    expect(matchesLaunchSignal(pons, '0x12345678' as Hex)).toBeNull()
    expect(launchpadEntry(pons)?.selectorNames?.[launchToken]).toBe('launchToken')
    const npm = MAINNET_ADDRESSES.nonfungiblePositionManager
    expect(matchesLaunchSignal(npm, `${toFunctionSelector('function multicall(bytes[])')}` as Hex)?.kind).toBe('position-manager')
    expect(matchesLaunchSignal(npm, `${toFunctionSelector('function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))')}` as Hex)).toBeNull()
    expect(matchesLaunchSignal(NOXA_ADDRESSES.launchFactory, '0xdeadbeef' as Hex)?.name).toBe('noxa')
    expect(matchesLaunchSignal(MAINNET_ADDRESSES.swapRouter02, '0xac9650d8' as Hex)).toBeNull()
  })
  it('keeps the arms.launchpads schema default in step with every registry name', () => {
    const def = (arms.launchpads as unknown as { default: string[] }).default
    for (const name of ALL_LAUNCHPADS) expect(def, name).toContain(name)
  })
})
