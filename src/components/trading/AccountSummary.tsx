/**
 * AccountSummary — the paper/managed account's headline numbers: balance,
 * equity, unrealized PnL, open-position count, win rate and the current losing
 * streak. Equity is marked to the live watchlist rates so the numbers move in
 * real time. When the consecutive-loss breaker trips, a clear "standing down"
 * notice explains why the robot went quiet.
 *
 * When `onAccountKindChange` is set (paper mode only), the card also offers the
 * Standard ↔ Micro ↔ Minimal ↔ Custom switch — a micro paper account starts from
 * a smaller balance, the minimal flavour from the smallest viable one ($10), and
 * the custom flavour from an amount the user deposits themselves — which keeps
 * position sizing proportionally small while testing a robot.
 */
import { useState } from 'react'
import { ShieldAlert, Wallet } from 'lucide-react'
import type { AccountState, PaperAccountKind, RatesMap } from '../../lib/trading/types'
import { equity, unrealizedPnl } from '../../lib/trading/engine'
import { consecutiveLosses } from '../../lib/trading/risk'
import { MIN_PAPER_DEPOSIT, PAPER_ACCOUNT_KINDS, startingBalanceForKind } from '../../lib/trading/accountKind'
import { formatUsd } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Card, CardContent, CardHeader, CardTitle } from '../ui'

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' | 'neutral' }) {
  return (
    <div className="rounded-lg border border-border/60 bg-secondary/40 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 tnum font-mono text-lg font-bold',
          tone === 'up' && 'text-up',
          tone === 'down' && 'text-down',
          tone === 'neutral' && 'text-foreground',
        )}
      >
        {value}
      </p>
    </div>
  )
}

export function AccountSummary({
  account,
  rates,
  onAccountKindChange,
}: {
  account: AccountState
  rates: RatesMap
  onAccountKindChange?: (kind: PaperAccountKind, balance?: number) => void
}) {
  const eq = equity(account, rates)
  const unreal = unrealizedPnl(account, rates)
  const pnl = eq - account.initialBalance
  // Legacy accounts saved before the kind option carry no kind — Standard.
  const kind: PaperAccountKind = account.risk.kind ?? 'standard'

  const wins = account.trades.filter((t) => t.pnl > 0).length
  const winRate = account.trades.length > 0 ? (wins / account.trades.length) * 100 : 0
  const streak = consecutiveLosses(account.trades)
  const breaker = account.risk.maxConsecutiveLosses
  const standingDown = breaker > 0 && streak >= breaker

  // Custom accounts take their displayed starting balance from the live account
  // (the kind preset is 0), and let the user set a fresh deposit inline.
  const [depositDraft, setDepositDraft] = useState('')
  const shownStartingBalance = kind === 'custom' ? account.initialBalance : startingBalanceForKind(kind)

  const applyCustomDeposit = () => {
    const amount = Math.round(Number(depositDraft))
    if (!Number.isFinite(amount) || amount < MIN_PAPER_DEPOSIT) return
    onAccountKindChange?.('custom', amount)
    setDepositDraft('')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-accent" aria-hidden="true" />
          Account
        </CardTitle>
      </CardHeader>
      <CardContent>
        {onAccountKindChange && (
          <div className="mb-4">
            <div
              role="group"
              aria-label="Paper account type"
              className="flex items-center gap-1 rounded-lg border border-border/60 bg-secondary/40 p-1"
            >
              {(Object.keys(PAPER_ACCOUNT_KINDS) as PaperAccountKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => {
                    if (k !== kind) onAccountKindChange(k)
                  }}
                  className={cn(
                    'flex-1 cursor-pointer rounded-md px-3 py-1.5 text-xs font-semibold transition-all duration-150 active:scale-[0.98]',
                    kind === k
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  )}
                >
                  {PAPER_ACCOUNT_KINDS[k].label}
                </button>
              ))}
            </div>
            {kind === 'custom' && (
              <div className="mt-2 flex items-center gap-2">
                <label htmlFor="custom-deposit" className="sr-only">
                  Custom paper deposit
                </label>
                <span className="shrink-0 rounded-md border border-border/60 bg-secondary/40 px-2 py-1.5 text-xs text-muted-foreground">
                  $
                </span>
                <input
                  id="custom-deposit"
                  type="number"
                  min={MIN_PAPER_DEPOSIT}
                  step={10}
                  inputMode="numeric"
                  placeholder={String(account.initialBalance)}
                  value={depositDraft}
                  onChange={(e) => setDepositDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyCustomDeposit()
                  }}
                  className="min-w-0 flex-1 rounded-md border border-border/60 bg-secondary/40 px-2.5 py-1.5 text-xs font-medium text-foreground outline-none transition-colors focus:border-accent"
                />
                <button
                  type="button"
                  onClick={applyCustomDeposit}
                  disabled={!depositDraft || Number(depositDraft) < MIN_PAPER_DEPOSIT}
                  className="shrink-0 cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-all duration-150 hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Set deposit
                </button>
              </div>
            )}
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {PAPER_ACCOUNT_KINDS[kind].description} Starting balance{' '}
              <span className="font-semibold text-foreground">{formatUsd(shownStartingBalance)}</span> —{' '}
              {kind === 'custom'
                ? depositDraft && Number(depositDraft) > 0 && Number(depositDraft) < MIN_PAPER_DEPOSIT
                  ? 'Minimum deposit is $10.'
                  : 'type an amount and press "Set deposit" to reset the account with it.'
                : 'switching account type resets the paper account.'}
            </p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Balance" value={formatUsd(account.balance)} tone="neutral" />
          <Stat label="Equity" value={formatUsd(eq)} tone="neutral" />
          <Stat label="Unrealized P&L" value={formatUsd(unreal)} tone={unreal >= 0 ? 'up' : 'down'} />
          <Stat
            label="Total P&L"
            value={`${formatUsd(pnl)} (${(account.initialBalance > 0 ? (pnl / account.initialBalance) * 100 : 0).toFixed(1)}%)`}
            tone={pnl >= 0 ? 'up' : 'down'}
          />
        </div>
        {standingDown && (
          <p role="status" className="mt-3 flex items-center gap-1.5 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {streak} losses in a row — the robot is standing down until a win resets the streak or you raise the
            limit in Risk management.
          </p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          {account.positions.length} open position{account.positions.length === 1 ? '' : 's'} ·{' '}
          {account.trades.length} closed trade{account.trades.length === 1 ? '' : 's'} · win rate{' '}
          <span className={cn('font-mono tnum font-semibold', winRate >= 50 ? 'text-up' : 'text-down')}>
            {winRate.toFixed(0)}%
          </span>
          {account.trades.length > 0 && (
            <>
              {' '}
              · current streak <span className="font-mono tnum font-semibold">{streak} loss{streak === 1 ? '' : 'es'}</span>
            </>
          )}
        </p>
      </CardContent>
    </Card>
  )
}