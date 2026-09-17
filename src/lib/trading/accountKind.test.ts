import { describe, expect, it } from 'vitest'
import { accountKindLabel, PAPER_ACCOUNT_KINDS, startingBalanceForKind } from './accountKind'

describe('paper account kinds', () => {
  it('offers standard, micro and minimal flavours', () => {
    expect(PAPER_ACCOUNT_KINDS.standard.startingBalance).toBe(10_000)
    expect(PAPER_ACCOUNT_KINDS.micro.startingBalance).toBe(1_000)
    expect(PAPER_ACCOUNT_KINDS.micro.label).toBe('Micro')
    expect(PAPER_ACCOUNT_KINDS.minimal.startingBalance).toBe(50)
    expect(PAPER_ACCOUNT_KINDS.minimal.label).toBe('Minimal')
  })

  it('maps a kind to its starting balance', () => {
    expect(startingBalanceForKind('standard')).toBe(10_000)
    expect(startingBalanceForKind('micro')).toBe(1_000)
    expect(startingBalanceForKind('minimal')).toBe(50)
  })

  it('defaults legacy accounts (no kind) to Standard', () => {
    expect(startingBalanceForKind(null)).toBe(10_000)
    expect(startingBalanceForKind(undefined)).toBe(10_000)
    expect(accountKindLabel(undefined)).toBe('Standard')
  })
})