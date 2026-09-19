/**
 * Layout — the app-wide shell wrapping every route.
 *
 * Restores the site chrome that was missing: a sticky header with the ANA24
 * brand, an auth-aware navigation menu (public links for visitors, app links
 * for signed-in users), a mobile menu toggle, and a footer. The routed page
 * renders inside <Outlet /> between the two.
 *
 * Nav behaviour per src/App.tsx: visitors see only the public menu; signed-in
 * users see the app menu and a "Sign out" action.
 */
import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { Activity, ChevronRight, Menu, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { cn } from '../lib/cn'
import { Button } from './ui'

interface NavItem {
  to: string
  label: string
}

const PUBLIC_NAV: NavItem[] = [
  { to: '/', label: 'Home' },
  { to: '/markets', label: 'Markets' },
  { to: '/packages', label: 'Packages' },
  { to: '/brokers', label: 'Brokers' },
  { to: '/help', label: 'Help' },
  { to: '/contact', label: 'Contact' },
]

const APP_NAV: NavItem[] = [
  { to: '/trading', label: 'Trading' },
  { to: '/performance', label: 'Performance' },
  { to: '/signals', label: 'Signals' },
  { to: '/backtester', label: 'Backtester' },
  { to: '/strategies', label: 'Strategies' },
  { to: '/account', label: 'Account' },
  { to: '/profile', label: 'Profile' },
  { to: '/configuration', label: 'Configuration' },
]

function Brand() {
  return (
    <Link
      to="/"
      className="group flex shrink-0 cursor-pointer items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      aria-label="ANA24 — home"
    >
      <span className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-primary via-primary to-secondary text-on-primary shadow-glow ring-1 ring-white/15 transition-transform duration-150 ease-out group-active:scale-95">
        <Activity className="h-5 w-5" aria-hidden="true" />
        <span aria-hidden="true" className="absolute inset-0 rounded-xl bg-gradient-to-t from-black/25 to-transparent opacity-60" />
      </span>
      <span className="font-heading text-lg font-bold tracking-tight text-foreground">
        ANA<span className="text-accent">24</span>
      </span>
    </Link>
  )
}

function NavLinkItem({ to, label }: NavItem) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'cursor-pointer rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          isActive
            ? 'bg-accent/15 text-accent'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )
      }
    >
      {label}
    </NavLink>
  )
}

function Header() {
  const { user, signOut } = useAuth()
  const location = useLocation()
  const [open, setOpen] = useState(false)

  // Close the mobile menu whenever the route changes.
  useEffect(() => {
    setOpen(false)
  }, [location.pathname])

  const items = user ? APP_NAV : PUBLIC_NAV

  return (
    <header className="relative sticky top-0 z-40 border-b border-border/70 bg-background/75 shadow-[0_12px_32px_-20px_rgb(2_6_23/0.9)] backdrop-blur-xl">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/80 to-transparent"
      />
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Brand />

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
          {items.map((item) => (
            <NavLinkItem key={item.to} {...item} />
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {user ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void signOut()}
              className="hidden sm:inline-flex"
            >
              Sign out
            </Button>
          ) : (
            <Link to="/auth" className="hidden sm:block">
              <Button size="sm">Sign in</Button>
            </Link>
          )}

          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-border bg-secondary/40 text-foreground transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.97] lg:hidden"
          >
            {open ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* Mobile nav */}
      {open && (
        <nav
          id="mobile-nav"
          aria-label="Mobile"
          className="border-t border-border bg-background px-4 py-3 lg:hidden"
        >
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    cn(
                      'flex cursor-pointer items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150 ease-out',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                      isActive
                        ? 'bg-accent/15 text-accent'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )
                  }
                >
                  {item.label}
                  <ChevronRight className="h-4 w-4 opacity-50" aria-hidden="true" />
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-border pt-3">
            {user ? (
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => {
                  setOpen(false)
                  void signOut()
                }}
              >
                Sign out
              </Button>
            ) : (
              <Link to="/auth" className="block">
                <Button className="w-full">Sign in</Button>
              </Link>
            )}
          </div>
        </nav>
      )}
    </header>
  )
}

const FOOTER_COLUMNS: { title: string; links: { to: string; label: string }[] }[] = [
  {
    title: 'Product',
    links: [
      { to: '/packages', label: 'Packages' },
      { to: '/brokers', label: 'Brokers' },
      { to: '/backtester', label: 'Backtester' },
      { to: '/strategies', label: 'Strategies' },
    ],
  },
  {
    title: 'Markets',
    links: [
      { to: '/markets', label: 'Market pairs' },
      { to: '/signals', label: 'Signals' },
      { to: '/performance', label: 'Performance' },
      { to: '/trading', label: 'Trading robot' },
    ],
  },
  {
    title: 'Support',
    links: [
      { to: '/help', label: 'Help centre' },
      { to: '/contact', label: 'Contact us' },
      { to: '/account', label: 'My account' },
      { to: '/referrals', label: 'Referrals' },
    ],
  },
]

function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer className="relative mt-auto border-t border-border/60 bg-secondary/10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent"
      />
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div>
          <Brand />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
            AI-assisted trading, risk-first by design. Run robots on a free paper account, backtest
            your ideas, and connect a real broker only when you're ready.
          </p>
        </div>
        {FOOTER_COLUMNS.map((col) => (
          <div key={col.title}>
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {col.title}
            </h3>
            <ul className="mt-4 space-y-2.5">
              {col.links.map((link) => (
                <li key={link.to + link.label}>
                  <Link
                    to={link.to}
                    className="cursor-pointer text-sm text-muted-foreground transition-colors duration-200 ease-out hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border/60">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          <p className="text-xs leading-relaxed text-muted-foreground/70">
            ANA24 is a trading-technology demonstration. Nothing on this site is financial advice.
            Trading involves substantial risk of loss — never trade with money you cannot afford to
            lose.
          </p>
          <p className="mt-3 text-xs text-muted-foreground/50">
            © {year} ANA24. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  )
}

/** Fixed ambient light field behind the whole app — layered depth over flat
 *  colour. Pointer-events disabled; purely decorative. */
function AmbientBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-background" />
      <div className="absolute -top-48 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-primary/12 blur-[130px]" />
      <div className="absolute -right-40 top-32 h-96 w-96 rounded-full bg-accent/8 blur-[110px]" />
      <div className="absolute -left-40 top-1/2 h-[420px] w-[420px] rounded-full bg-secondary/8 blur-[130px]" />
    </div>
  )
}

export default function Layout() {
  return (
    <div className="isolate flex min-h-screen flex-col">
      <AmbientBackground />
      <Header />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  )
}