/**
 * AddOnsSection — the add-on catalog on the Packages page. Renders each active
 * add-on with its price and a buy button; shows how many slots the user already
 * owns from their active purchases.
 *
 * Catalog groups shown:
 *   - Extra slots ('slot'): 1 slot = 1 robot + 1 trading account.
 *   - Duration subscriptions ('copy_trading' / 'ads'): time-based grants that
 *     unlock copying pro traders or running ads while active. Copy trading's
 *     1-day tier is sold WITHOUT referral commission.
 */
import { Megaphone, PackagePlus, Users } from 'lucide-react'
import type { AddonPurchaseRow, AddonRow } from '../lib/types'
import { formatUsd } from '../lib/format'
import { cn } from '../lib/cn'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from './ui'

const KIND_LABEL: Record<AddonRow['kind'], string> = {
  slot: 'Extra slot',
  robot: 'Robot slot',
  mt_account: 'MT account slot',
  ads: 'Ads subscription',
  copy_trading: 'Copy trading',
}

/** Duration-based subscription kinds: billed per billing cycle, not per slot. */
const SUBSCRIPTION_KINDS: AddonRow['kind'][] = ['copy_trading', 'ads']

/** What one purchase of this add-on grants, as a human string. */
function slotSummary(a: AddonRow): string {
  if (a.kind === 'slot') {
    const n = Math.max(1, a.amount)
    return `+${n} extra slot${n === 1 ? '' : 's'} — each slot adds 1 robot + 1 trading account`
  }
  if (a.kind === 'copy_trading') {
    return `Copy any pro trader's full configuration for ${a.duration_days} day${a.duration_days === 1 ? '' : 's'}`
  }
  if (a.kind === 'ads') {
    return `Run your ad across the platform for ${a.duration_days} day${a.duration_days === 1 ? '' : 's'}`
  }
  // Legacy kinds (historical rows only): plain per-kind wording.
  return `+${a.amount} ${KIND_LABEL[a.kind].toLowerCase()}${a.amount === 1 ? '' : 's'}`
}

export function AddOnsSection({
  addons,
  purchases,
  onPurchase,
  disabled,
}: {
  addons: AddonRow[]
  purchases: AddonPurchaseRow[]
  onPurchase: (addon: AddonRow) => void
  disabled?: boolean
}) {
  const active = addons.filter((a) => a.active)

  if (active.length === 0) return null

  const slotAddons = active.filter((a) => a.kind === 'slot')
  const copyAddons = active.filter((a) => a.kind === 'copy_trading')
  const adsAddons = active.filter((a) => a.kind === 'ads')
  const legacyAddons = active.filter((a) => a.kind !== 'slot' && !SUBSCRIPTION_KINDS.includes(a.kind))

  const owned = (kind: AddonRow['kind']): number =>
    purchases
      .filter((p) => p.status === 'active' && p.addons?.kind === kind)
      .reduce((sum, p) => sum + (p.addons?.amount ?? 0), 0)

  const renderCard = (a: AddonRow) => {
    const mine = owned(a.kind)
    const isSub = SUBSCRIPTION_KINDS.includes(a.kind)
    const noCommission = isSub && (a.commission_pct ?? 0) === 0
    return (
      <div
        key={a.id}
        className="flex flex-col justify-between gap-3 rounded-xl border border-border/60 bg-secondary/30 p-4"
      >
        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-foreground">{a.name}</p>
            <Badge className="border-accent/40 bg-accent/10 text-accent">{KIND_LABEL[a.kind]}</Badge>
          </div>
          {a.description && <p className="mt-1 text-xs text-muted-foreground">{a.description}</p>}
          <p className="mt-2 text-sm">
            <span className="font-mono text-lg font-bold text-foreground">{formatUsd(a.price)}</span>
            {isSub ? (
              <span className="ml-1 text-xs text-muted-foreground">/ {a.duration_days}d subscription</span>
            ) : (
              <span className="ml-1 text-xs text-muted-foreground">/ {a.duration_days}d</span>
            )}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {slotSummary(a)}
            {mine > 0 && <span className="text-up"> · {isSub ? 'active' : `${mine} owned`}</span>}
          </p>
          {noCommission && (
            <p className="mt-1.5 inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              No referral commission
            </p>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => onPurchase(a)}
          className={cn('w-full')}
        >
          {isSub ? 'Subscribe' : 'Buy add-on'}
        </Button>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PackagePlus className="h-4 w-4 text-accent" aria-hidden="true" />
          Add-ons
        </CardTitle>
        <span className="text-xs text-muted-foreground">
          Extra slots add 1 robot + 1 trading account each. Copy trading and ads subscriptions unlock copying pro
          traders and running ads while your subscription is active.
        </span>
      </CardHeader>
      <CardContent>
        {slotAddons.length > 0 && (
          <>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <PackagePlus className="h-3.5 w-3.5" aria-hidden="true" />
              Extra slots
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {slotAddons.map(renderCard)}
            </div>
          </>
        )}
        {copyAddons.length > 0 && (
          <div className={cn(slotAddons.length > 0 && 'mt-6')}>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              Copy trading — duration subscription
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {copyAddons.map(renderCard)}
            </div>
          </div>
        )}
        {adsAddons.length > 0 && (
          <div className={cn((slotAddons.length > 0 || copyAddons.length > 0) && 'mt-6')}>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Megaphone className="h-3.5 w-3.5" aria-hidden="true" />
              Ads — duration subscription
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {adsAddons.map(renderCard)}
            </div>
          </div>
        )}
        {legacyAddons.length > 0 && (
          <div className={cn((slotAddons.length > 0 || copyAddons.length > 0 || adsAddons.length > 0) && 'mt-6')}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {legacyAddons.map(renderCard)}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
