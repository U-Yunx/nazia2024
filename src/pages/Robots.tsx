/**
 * Robots — the robot-slot manager.
 *
 * Every user gets up to three robot slots. Each slot owns its own paper /
 * managed ledger, its own saved configuration (method, pairs, sizing, risk,
 * limits) and its own activity feed — so you can run a scalper and a
 * long-term robot side by side without them sharing a balance or stepping on
 * each other's trades. Slot 1 keeps the classic single-robot behaviour (and
 * all existing saved data); slots 2 and 3 are namespaced copies.
 *
 * This page lists the slots with their live ledger balance and takes you to
 * the Trading screen with the right slot selected (/trading?robot=N).
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Bot, CheckCircle2, Circle, Lock, PlusCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { formatUsd } from '../lib/format'
import { cn } from '../lib/cn'
import { Badge, Button, Card, CardContent, PageHeader, Skeleton } from '../components/ui'

export const MAX_ROBOT_SLOTS = 3

interface SlotRow {
  robot_number: number
  broker: string
  balance: number
  initial_balance: number
  updated_at: string | null
}

/** The slots a signed-in user may run (slot 1 is always available). */
export function robotSlots(owned: number[]): number[] {
  const slots: number[] = []
  for (let n = 1; n <= MAX_ROBOT_SLOTS; n++) slots.push(n)
  return slots
}

export function Robots() {
  const { user } = useAuth()
  const [rows, setRows] = useState<SlotRow[] | null>(null)

  useEffect(() => {
    let active = true
    setRows(null)
    if (!user) return
    void (async () => {
      const { data } = await supabase
        .from('paper_accounts')
        .select('robot_number, broker, balance, initial_balance, updated_at')
        .eq('user_id', user.id)
        .order('robot_number', { ascending: true })
      if (active) setRows((data as unknown as SlotRow[] | null) ?? [])
    })()
    return () => {
      active = false
    }
  }, [user?.id])

  if (!user) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Your robots"
          description="Run up to three trading robots side by side — each with its own account, settings and history."
        />
        <Card>
          <CardContent>
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent">
                <Bot className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">Sign in to manage your robots</h2>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                  Create a free account and every robot slot — its balance, settings and history — is backed up to
                  your profile automatically.
                </p>
              </div>
              <Link to="/auth">
                <Button>
                  Sign in / create account
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const loading = rows == null
  const bySlot = new Map<number, SlotRow>()
  for (const r of rows ?? []) bySlot.set(r.robot_number, r)
  const owned = [...bySlot.keys()]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your robots"
        description="Every slot is a fully independent trading robot — its own paper or managed ledger, its own method, pairs, sizing, risk and limits. A scalper on slot 1 and a long-term swing robot on slot 2 never share a balance or touch each other's trades."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {robotSlots(owned).map((n) => {
          const row = bySlot.get(n)
          const active = row != null
          const started = active && row.robot_number === n
          return (
            <Card key={n} className={cn(active && 'border-accent/40')}>
              <CardContent>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg font-bold',
                        active ? 'bg-accent/15 text-accent' : 'bg-secondary text-muted-foreground',
                      )}
                    >
                      {n}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-foreground">
                        Robot {n}
                        {n === 1 && <span className="ml-2 text-xs font-normal text-muted-foreground">(classic)</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {started ? 'Active ledger' : 'Empty slot — open it to start'}
                      </p>
                    </div>
                  </div>
                  {active ? (
                    <Badge className="border-up/30 bg-up/15 text-up">
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                      In use
                    </Badge>
                  ) : (
                    <Badge className="border-border bg-muted text-muted-foreground">
                      <Circle className="h-3.5 w-3.5" aria-hidden="true" />
                      Free
                    </Badge>
                  )}
                </div>

                {active && row ? (
                  <dl className="mt-4 grid grid-cols-2 gap-3">
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Balance</dt>
                      <dd className="mt-0.5 text-xl font-bold tnum text-foreground">{formatUsd(row.balance)}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Started from</dt>
                      <dd className="mt-0.5 text-sm font-medium tnum text-foreground">{formatUsd(row.initial_balance)}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Ledger</dt>
                      <dd className="mt-0.5 text-sm capitalize text-foreground">{row.broker === 'managed' ? 'Managed live' : 'Paper'}</dd>
                    </div>
                    <div>
                      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Account</dt>
                      <dd className="mt-0.5 text-sm text-foreground">Slot {n}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    Open this slot and it gets its own starting balance, saved settings and trade journal — completely
                    independent of your other robots.
                  </p>
                )}

                <div className="mt-5">
                  <Link to={n === 1 ? '/trading' : `/trading?robot=${n}`} className="block">
                    <Button variant={active ? 'secondary' : 'primary'} className="w-full">
                      {active ? (
                        <>
                          <Bot className="h-4 w-4" aria-hidden="true" />
                          Open Robot {n}
                        </>
                      ) : (
                        <>
                          <PlusCircle className="h-4 w-4" aria-hidden="true" />
                          Create Robot {n}
                        </>
                      )}
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {loading && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-2xl" />
          ))}
        </div>
      )}

      <div className="rounded-xl border border-border bg-secondary/30 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Lock className="h-4 w-4 text-accent" aria-hidden="true" />
          How slots work
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li>
            <span className="font-semibold text-foreground">Independent ledgers.</span> Each slot owns its own balance
            and trade journal — robot 2 starts from a fresh balance and its trades never mix with robot 1's.
          </li>
          <li>
            <span className="font-semibold text-foreground">Independent settings.</span> Method, pairs, sizing, risk and
            session limits are saved per slot, so you can run a scalper and a long-term robot side by side.
          </li>
          <li>
            <span className="font-semibold text-foreground">Background continuation.</span> Every slot's paper/managed
            robot keeps trading server-side when you close the tab, exactly like the classic robot — each with its own
            run, session and history.
          </li>
          <li>
            <span className="font-semibold text-foreground">Slots are yours.</span> Backed up to your profile, so
            switching devices brings all three robots back.
          </li>
        </ul>
      </div>
    </div>
  )
}
