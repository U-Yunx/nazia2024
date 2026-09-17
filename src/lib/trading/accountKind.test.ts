import { describe, expect, it } from 'vitest'
import { accountKindLabel, MIN_PAPER_DEPOSIT, PAPER_ACCOUNT_KINDS, startingBalanceForKind } from './accountKind'

describe('paper account kinds', () => {
  it('offers standard, micro, minimal and custom flavours', () => {
    expect(PAPER_ACCOUNT_KINDS.standard.startingBalance).toBe(10_000)
    expect(PAPER_ACCOUNT_KINDS.micro.startingBalance).toBe(1_000)
    expect(PAPER_ACCOUNT_KINDS.micro.label).toBe('Micro')
    expect(PAPER_ACCOUNT_KINDS.minimal.startingBalance).toBe(MIN_PAPER_DEPOSIT)
    expect(PAPER_ACCOUNT_KINDS.minimal.label).toBe('Minimal')
    expect(PAPER_ACCOUNT_KINDS.custom.custom).toBe(true)
    expect(PAPER_ACCOUNT_KINDS.custom.label).toBe('Custom')
  })

  it('maps a kind to its starting balance', () => {
    expect(startingBalanceForKind('standard')).toBe(10_000)
    expect(startingBalanceForKind('micro')).toBe(1_000)
    expect(startingBalanceForKind('minimal')).toBe(10)
  })

  it('enforces the smallest allowed deposit at $10', () => {
    expect(MIN_PAPER_DEPOSIT).toBe(10)
    expect(startingBalanceForKind('minimal')).toBe(MIN_PAPER_DEPOSIT)
  })

  it('defaults legacy accounts (no kind) to Standard', () => {
    expect(startingBalanceForKind(null)).toBe(10_000)
    expect(startingBalanceForKind(undefined)).toBe(10_000)
    expect(accountKindLabel(undefined)).toBe('Standard')
  })
})