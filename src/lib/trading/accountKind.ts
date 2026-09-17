/**
 * Paper-account flavours. A "micro" paper account behaves like a real broker
 * micro account: it starts with a small balance and — because every position
 * is sized as a % of equity — it trades proportionally small (micro-lot-sized)
 * positions. Same robot rules, just a small account to practice on.
 */
import type { PaperAccountKind } from './types'

export interface PaperAccountKindInfo {
  label: string
  /** Starting balance the paper account is reset to for this flavour. */
  startingBalance: number
  description: string
}

export const PAPER_ACCOUNT_KINDS: Record<PaperAccountKind, PaperAccountKindInfo> = {
  standard: {
    label: 'Standard',
    startingBalance: 10_000,
    description: 'Full-size demo account — trade with a ten-thousand-dollar paper balance.',
  },
  micro: {
    label: 'Micro',
    startingBalance: 1_000,
    description: 'Small demo account — micro-lot-sized positions, ideal for testing a new robot setup.',
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