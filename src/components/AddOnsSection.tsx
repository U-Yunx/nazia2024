/**
 * AddOnsSection — the add-on catalog on the Packages page. Renders each active
 * add-on with its price and a buy button; shows how many slots the user already
 * owns from their active purchases.
 *
 * Every add-on grants bundled SLOTS: 1 slot = 1 robot + 1 trading account.
 * The four catalog items are "1 / 2 / 3 / 4 extra slots".
 */
import { PackagePlus } from 'lucide-react'
import type { AddonPurchaseRow, AddonRow } from '../lib/types'
import { formatUsd } from '../lib/format'
import { cn } from '../lib/cn'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from './ui'

const KIND_LABEL: Record<AddonRow['kind'], string> = {
  slot: 'Extra slot',
  robot: 'Robot slot',
  mt_account: 'MT account slot',
  ads: 'Ad slot',
}

/** What one purchase of this add-on grants, as a human string. */
function slotSummary(a: AddonRow): string {
  if (a.kind === 'slot') {
    const n = Math.max(1, a.amount)
    return `+${n} extra slot${n === 1 ? '' : 's'} — each slot adds 1 robot + 1 trading account`
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

  const owned = (kind: AddonRow['kind']): number =>
    purchases
      .filter((p) => p.status === 'active' && p.addons?.kind === kind)
      .reduce((sum, p) => sum + (p.addons?.amount ?? 0), 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PackagePlus className="h-4 w-4 text-accent" aria-hidden="true" />
          Add-ons
        </CardTitle>
        <span className="text-xs text-muted-foreground">
          Extend your package — every extra slot adds 1 robot + 1 trading account.
        </span>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {active.map((a) => {
            const mine = owned(a.kind)
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
                    <span className="ml-1 text-xs text-muted-foreground">/ {a.duration_days}d</span>
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {slotSummary(a)}
                    {mine > 0 && <span className="text-up"> · {mine} owned</span>}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onPurchase(a)}
                  className={cn('w-full')}
                >
                  Buy add-on
                </Button>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
