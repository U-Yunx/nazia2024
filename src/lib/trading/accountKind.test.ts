import { describe, expect, it } from 'vitest'
import { accountKindLabel, PAPER_ACCOUNT_KINDS, startingBalanceForKind } from './accountKind'

describe('paper account kinds', () => {
  it('offers standard and micro flavours', () => {
    expect(PAPER_ACCOUNT_KINDS.standard.startingBalance).toBe(10_000)
    expect(PAPER_ACCOUNT_KINDS.micro.startingBalance).toBe(1_000)
    expect(PAPER_ACCOUNT_KINDS.micro.label).toBe('Micro')
  })

  it('maps a kind to its starting balance', () => {
    expect(startingBalanceForKind('standard')).toBe(10_000)
    expect(startingBalanceForKind('micro')).toBe(1_000)
  })

  it('defaults legacy accounts (no kind) to Standard', () => {
    expect(startingBalanceForKind(null)).toBe(10_000)
    expect(startingBalanceForKind(undefined)).toBe(10_000)
    expect(accountKindLabel(undefined)).toBe('Standard')
  })
})