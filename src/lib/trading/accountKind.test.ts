import { describe, expect, it } from 'vitest'
import {
  accountKindLabel,
  contractSizeForKind,
  contractUnitsLabel,
  MIN_PAPER_DEPOSIT,
  PAPER_ACCOUNT_KINDS,
  startingBalanceForKind,
} from './accountKind'

describe('paper account kinds', () => {
  it('offers standard, mini, micro, nano, minimal and custom flavours', () => {
    expect(PAPER_ACCOUNT_KINDS.standard.startingBalance).toBe(10_000)
    expect(PAPER_ACCOUNT_KINDS.standard.label).toBe('Standard')
    expect(PAPER_ACCOUNT_KINDS.mini.startingBalance).toBe(2_000)
    expect(PAPER_ACCOUNT_KINDS.mini.label).toBe('Mini')
    expect(PAPER_ACCOUNT_KINDS.micro.startingBalance).toBe(1_000)
    expect(PAPER_ACCOUNT_KINDS.micro.label).toBe('Micro')
    expect(PAPER_ACCOUNT_KINDS.nano.startingBalance).toBe(100)
    expect(PAPER_ACCOUNT_KINDS.nano.label).toBe('Nano')
    expect(PAPER_ACCOUNT_KINDS.minimal.startingBalance).toBe(MIN_PAPER_DEPOSIT)
    expect(PAPER_ACCOUNT_KINDS.minimal.label).toBe('Minimal')
    expect(PAPER_ACCOUNT_KINDS.custom.custom).toBe(true)
    expect(PAPER_ACCOUNT_KINDS.custom.label).toBe('Custom')
  })

  it('maps each kind to a broker-style contract size', () => {
    expect(contractSizeForKind('standard')).toBe(100_000)
    expect(contractSizeForKind('mini')).toBe(10_000)
    expect(contractSizeForKind('micro')).toBe(1_000)
    expect(contractSizeForKind('nano')).toBe(100)
    expect(contractSizeForKind('minimal')).toBe(100)
    expect(contractSizeForKind('custom')).toBe(100_000)
    expect(contractUnitsLabel('standard')).toBe('100,000 units')
    expect(contractUnitsLabel('mini')).toBe('10,000 units')
  })

  it('maps a kind to its starting balance', () => {
    expect(startingBalanceForKind('standard')).toBe(10_000)
    expect(startingBalanceForKind('mini')).toBe(2_000)
    expect(startingBalanceForKind('micro')).toBe(1_000)
    expect(startingBalanceForKind('nano')).toBe(100)
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
    expect(contractSizeForKind(undefined)).toBe(100_000)
  })
})