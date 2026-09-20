/**
 * TradeForm — manual order entry. Picks a pair + side, computes a risk-based
 * position size (or lets the user override units), and shows the implied stop
 * and target levels before submitting through the active broker. The optional
 * per-trade profit target / loss cap can be entered in dollars or pips — pip
 * entries are converted to the $ stamp the engine enforces (pips × pip value
 * × units) at submit.
 */
import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { AccountState, OpenPositionRequest, RatesMap, Side } from '../../lib/trading/types'
import { equity, MIN_TRADE_BALANCE_USD } from '../../lib/trading/engine'
import { pipValueUsd, stopTakePrices, suggestPositionUnits } from '../../lib/trading/risk'
import { WATCHLIST } from '../../lib/watchlist'
import { formatPrice, formatUsd } from '../../lib/format'
import { cn } from '../../lib/cn'
import { Button, Input, Select } from '../ui'
import { CollapsibleCard } from './CollapsibleCard'
import { formatLots, lotsToUnits, unitsToLots } from '../../lib/trading/lots'
import { contractSizeForKind } from '../../lib/trading/accountKind'

export function TradeForm({
  account,
  rates,
  onOpen,
}: {
  account: AccountState
  rates: RatesMap
  onOpen: (req: OpenPositionRequest, rates: RatesMap) => Promise<{ error: string | null }>
}) {
  const [symbol, setSymbol] = useState('EUR/USD')
  const [side, setSide] = useState<Side>('long')
  const [stopPips, setStopPips] = useState(20)
  const [takePips, setTakePips] = useState(40)
  const [units, setUnits] = useState<number | null>(null)
  // Position size unit: raw contract units or forex lots (1 lot = 100,000 units).
  const [sizeUnit, setSizeUnit] = useState<'units' | 'lots'>('units')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const [targetUnit, setTargetUnit] = useState<'usd' | 'pips'>('usd')
  // The per-trade profit target & loss cap in the chosen unit (0 = off).
  const [profitTarget, setProfitTarget] = useState(0)
  const [lossCap, setLossCap] = useState(0)

  const price = rates[symbol]
  const pipValue = pipValueUsd(symbol, rates)
  // One lot = a different number of units per account kind (Standard 100,000,
  // Mini 10,000, Micro 1,000, Nano/Minimal 100) — lots convert at this size.
  const contractSize = contractSizeForKind(account.risk.kind)
  // Sub-$1 balance: nothing left to risk — the whole form is locked. The
  // engine's canOpen gate refuses entries at the same threshold, so this is
  // purely a UI mirror (and a human explanation instead of a silent disable).
  const locked = account.balance < MIN_TRADE_BALANCE_USD
  const suggested = useMemo(() => {
    if (pipValue == null || pipValue <= 0) return 0
    return suggestPositionUnits({
      equity: equity(account, rates),
      riskPct: account.risk.riskPerTradePct,
      stopPips,
      pipValue,
    })
  }, [account, rates, pipValue, stopPips])

  const effectiveUnits = units ?? suggested
  const levels = useMemo(
    () => (price != null ? stopTakePrices(symbol, side, price, stopPips, takePips) : null),
    [symbol, side, price, stopPips, takePips],
  )

  const submit = async () => {
    if (price == null) {
      setError('No live price for this pair yet — pick a pair that is quoting.')
      return
    }
    if (effectiveUnits <= 0) {
      setError('Position size is zero — lower the stop or raise the risk per trade.')
      return
    }
    // Convert pip-denominated targets to the $ stamp the engine enforces.
    let targetProfitUsd = profitTarget || undefined
    let targetLossUsd = lossCap || undefined
    if (targetUnit === 'pips' && pipValue != null) {
      targetProfitUsd = profitTarget > 0 ? profitTarget * pipValue * effectiveUnits : undefined
      targetLossUsd = lossCap > 0 ? lossCap * pipValue * effectiveUnits : undefined
    }
    setBusy(true)
    setError(null)
    setOk(false)
    const res = await onOpen(
      {
        symbol,
        side,
        entryPrice: price,
        stopPips,
        takeProfitPips: takePips,
        units: effectiveUnits,
        strategy: 'manual',
        targetProfitUsd,
        targetLossUsd,
      },
      rates,
    )
    setBusy(false)
    if (res.error) {
      setError(res.error)
      return
    }
    setOk(true)
  }

  return (
    <CollapsibleCard title="Manual trade">
        <div className="grid grid-cols-2 gap-3">
          <Select label="Pair" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {WATCHLIST.map((p) => (
              <option key={p.symbol} value={p.symbol}>
                {p.symbol} — {p.name}
              </option>
            ))}
          </Select>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Side</span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSide('long')}
                className={cn(
                  'flex cursor-pointer items-center justify-center gap-1 rounded-lg border px-3 py-2 text-sm font-semibold',
                  side === 'long'
                    ? 'border-up/60 bg-up/15 text-up'
                    : 'border-border bg-background/60 text-muted-foreground hover:text-foreground',
                )}
              >
                <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /> Buy
              </button>
              <button
                type="button"
                onClick={() => setSide('short')}
                className={cn(
                  'flex cursor-pointer items-center justify-center gap-1 rounded-lg border px-3 py-2 text-sm font-semibold',
                  side === 'short'
                    ? 'border-down/60 bg-down/15 text-down'
                    : 'border-border bg-background/60 text-muted-foreground hover:text-foreground',
                )}
              >
                <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" /> Sell
              </button>
            </div>
          </div>
          <Input
            label="Stop loss"
            type="number"
            min={1}
            step={1}
            value={stopPips}
            onChange={(e) => setStopPips(Number(e.target.value))}
          />
          <Input
            label="Take profit"
            type="number"
            min={1}
            step={1}
            value={takePips}
            onChange={(e) => setTakePips(Number(e.target.value))}
          />
          <div className="col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Per-trade target unit</span>
            <div
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1"
              role="group"
              aria-label="Per-trade profit unit"
            >
              {(['usd', 'pips'] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setTargetUnit(u)}
                  aria-pressed={targetUnit === u}
                  className={cn(
                    'h-8 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors duration-150',
                    targetUnit === u ? 'bg-accent text-black' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {u === 'usd' ? 'USD' : 'Pips'}
                </button>
              ))}
              <span className="pl-1 pr-2 text-xs text-muted-foreground">
                {targetUnit === 'pips' ? 'Entries below are in pips' : 'Entries below are in US dollars'}
              </span>
            </div>
          </div>
          <Input
            label={`Profit target (${targetUnit === 'pips' ? 'pips' : '$'})`}
            type="number"
            min={0}
            step={targetUnit === 'pips' ? 1 : 5}
            value={profitTarget}
            onChange={(e) => setProfitTarget(Math.max(0, Number(e.target.value)))}
          />
          <Input
            label={`Loss cap (${targetUnit === 'pips' ? 'pips' : '$'})`}
            type="number"
            min={0}
            step={1}
            value={lossCap}
            onChange={(e) => setLossCap(Math.max(0, Number(e.target.value)))}
          />
          <div className="col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Position size</span>
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1"
                role="group"
                aria-label="Position size unit"
              >
                {(['units', 'lots'] as const).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => setSizeUnit(u)}
                    aria-pressed={sizeUnit === u}
                    className={cn(
                      'h-8 cursor-pointer rounded-md px-3 text-sm font-medium transition-colors duration-150',
                      sizeUnit === u ? 'bg-accent text-black' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {u === 'units' ? 'Units' : 'Lots'}
                  </button>
                ))}
              </div>
              <span className="text-[11px] text-muted-foreground">
                1 lot = {contractSize.toLocaleString('en-US')} units on this account — the order is always placed in units under the hood.
              </span>
            </div>
          </div>
          {sizeUnit === 'lots' ? (
            <Input
              label={`Lots (suggested ${formatLots(unitsToLots(suggested, contractSize))})`}
              type="number"
              min={0.01}
              step={0.01}
              value={units == null ? '' : formatLots(unitsToLots(units, contractSize))}
              onChange={(e) => {
                const raw = e.target.value
                if (raw === '') return setUnits(null)
                const lots = Number(raw)
                if (!Number.isFinite(lots) || lots <= 0) return
                setUnits(lotsToUnits(lots, contractSize))
              }}
            />
          ) : (
            <Input
              label={`Units (suggested ${suggested})`}
              type="number"
              min={1}
              step={1}
              value={effectiveUnits}
              onChange={(e) => {
                const raw = e.target.value
                if (raw === '') return setUnits(null)
                const u = Number(raw)
                if (Number.isFinite(u) && u > 0) setUnits(Math.round(u))
              }}
            />
          )}
          <div className="flex items-end rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
            <div>
              <p className="text-[11px] uppercase tracking-wide">Market</p>
              <p className="tnum font-mono text-sm text-foreground">{formatPrice(price)}</p>
              {levels && (
                <p className="mt-0.5 tnum font-mono text-[11px]">
                  Stop {formatPrice(levels.stopPrice)} · Target {formatPrice(levels.takeProfitPrice)}
                </p>
              )}
            </div>
          </div>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Targets auto-close the trade at that profit or that loss — entered in{' '}
          {targetUnit === 'pips' ? 'pips and converted to $ at your size' : 'dollars'}; 0 = off.
        </p>

        {pipValue != null && (
          <p className="mt-3 text-xs text-muted-foreground">
            Pip value ≈ <span className="tnum font-mono">{formatUsd(pipValue)}</span>/unit · risk at stop ≈{' '}
            <span className="tnum font-mono">{formatUsd(pipValue * stopPips * effectiveUnits)}</span>
            {targetUnit === 'pips' && profitTarget > 0 && (
              <>
                {' '}· profit at {profitTarget} pips ≈{' '}
                <span className="tnum font-mono">{formatUsd(profitTarget * pipValue * effectiveUnits)}</span>
              </>
            )}
          </p>
        )}

        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {ok && (
          <p role="status" className="mt-3 rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-xs text-up">
            Order placed. It will be marked to market as prices update.
          </p>
        )}

        {locked && (
          <p role="status" className="mt-3 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-xs text-amber">
            Balance is below $1 — trading is locked. Reset or top up the account to place orders again.
          </p>
        )}

        <Button
          className="mt-4 w-full"
          loading={busy}
          onClick={() => void submit()}
          disabled={price == null || locked}
        >
          {side === 'long' ? 'Buy' : 'Sell'} {symbol}
        </Button>
      </CollapsibleCard>
  )
}