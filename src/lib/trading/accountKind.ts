/**
 * Paper-account flavours. Each preset behaves like the real broker account of
 * the same name: a starting balance AND a contract size per lot. A "mini"
 * paper account, for instance, starts with $2,000 and trades 10,000-unit lots
 * (exactly like a broker mini account), a "micro" trades 1,000-unit lots and
 * a "nano" trades 100-unit lots — so the same robot rules run at a scale that
 * matches the deposit.
 */
import type { PaperAccountKind } from './types'

/** Smallest allowed paper deposit (used by the minimal flavour and custom deposits). */
export const MIN_PAPER_DEPOSIT = 10

export interface PaperAccountKindInfo {
  label: string
  /** Starting balance the paper account is reset to for this flavour. */
  startingBalance: number
  /** Contract size (base-currency units per 1.00 lot) for this flavour. */
  contractSize: number
  description: string
  /** True for the user-defined 'custom' flavour — the starting balance comes from
   * the user (via setAccountKind('custom', amount)), not from a preset value. */
  custom?: boolean
}

export const PAPER_ACCOUNT_KINDS: Record<PaperAccountKind, PaperAccountKindInfo> = {
  standard: {
    label: 'Standard',
    startingBalance: 10_000,
    contractSize: 100_000,
    description: 'Full-size demo account — trade with a ten-thousand-dollar paper balance and standard 100,000-unit lots.',
  },
  mini: {
    label: 'Mini',
    startingBalance: 2_000,
    contractSize: 10_000,
    description: 'Mini demo account — $2,000 balance and 10,000-unit lots for tighter, more precise position sizing.',
  },
  micro: {
    label: 'Micro',
    startingBalance: 1_000,
    contractSize: 1_000,
    description: 'Small demo account — $1,000 balance and 1,000-unit lots, ideal for testing a new robot setup.',
  },
  nano: {
    label: 'Nano',
    startingBalance: 100,
    contractSize: 100,
    description: 'Tiny demo account — $100 balance with 100-unit nano lots, so even a small deposit trades naturally.',
  },
  minimal: {
    label: 'Minimal',
    startingBalance: MIN_PAPER_DEPOSIT,
    contractSize: 100,
    description: 'Smallest viable demo account — prove a robot works on a $10 deposit (100-unit lots) before scaling it up.',
  },
  custom: {
    label: 'Custom',
    startingBalance: 0,
    contractSize: 100_000,
    custom: true,
    description: 'Deposit any amount you like — the robot runs on your own paper balance (standard 100,000-unit lots).',
  },
}

/** Human label for a kind, defaulting to Standard for legacy/absent data. */
export function accountKindLabel(kind: PaperAccountKind | null | undefined): string {
  return (kind && PAPER_ACCOUNT_KINDS[kind]?.label) ?? PAPER_ACCOUNT_KINDS.standard.label
}

/** Starting balance for a kind; legacy accounts without a kind default to Standard. */
export function startingBalanceForKind(kind: PaperAccountKind | null | undefined): number {
  return (kind && PAPER_ACCOUNT_KINDS[kind]?.startingBalance) ?? PAPER_ACCOUNT_KINDS.standard.startingBalance
}

/** Contract size (units per 1 lot) for a kind; legacy accounts default to Standard. */
export function contractSizeForKind(kind: PaperAccountKind | null | undefined): number {
  return (kind && PAPER_ACCOUNT_KINDS[kind]?.contractSize) ?? PAPER_ACCOUNT_KINDS.standard.contractSize
}

/** Human-readable contract size, e.g. 100,000 units, 10,000 units. */
export function contractUnitsLabel(kind: PaperAccountKind | null | undefined): string {
  return `${contractSizeForKind(kind).toLocaleString('en-US')} units`
}