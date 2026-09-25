/**
 * ANA24 — app shell.
 *
 * React Router setup for the whole platform: every route renders inside the
 * shared Layout (header, footer, ambient background, live-progress bar for
 * signed-in users). Pages are lazy-loaded so visitors only download the code
 * for routes they actually open.
 *
 * Auth is handled per-page via `useAuth` (sign-in state + redirects), so the
 * router stays flat: public pages and app pages share the same tree and each
 * page decides what a signed-out visitor may see (e.g. Home redirects to
 * /auth for app CTAs, Trading shows the paper account without an account).
 */
import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Activity } from 'lucide-react'
import Layout from './components/Layout'
import { AuthProvider } from './hooks/useAuth'

const Home = lazy(() => import('./pages/Home').then((m) => ({ default: m.Home })))
const MarketPairs = lazy(() => import('./pages/MarketPairs').then((m) => ({ default: m.MarketPairs })))
const Packages = lazy(() => import('./pages/Packages').then((m) => ({ default: m.Packages })))
const Brokers = lazy(() => import('./pages/Brokers').then((m) => ({ default: m.Brokers })))
const Help = lazy(() => import('./pages/Help').then((m) => ({ default: m.Help })))
const Contact = lazy(() => import('./pages/Contact').then((m) => ({ default: m.Contact })))
const Auth = lazy(() => import('./pages/Auth').then((m) => ({ default: m.Auth })))
const TradingHub = lazy(() => import('./pages/TradingHub').then((m) => ({ default: m.TradingHub })))
const Robots = lazy(() => import('./pages/Robots').then((m) => ({ default: m.Robots })))
const Performance = lazy(() => import('./pages/Performance').then((m) => ({ default: m.Performance })))
const Signals = lazy(() => import('./pages/Signals').then((m) => ({ default: m.Signals })))
const Backtester = lazy(() => import('./pages/Backtester').then((m) => ({ default: m.Backtester })))
const Strategies = lazy(() => import('./pages/Strategies').then((m) => ({ default: m.Strategies })))
const Account = lazy(() => import('./pages/Account').then((m) => ({ default: m.Account })))
const Profile = lazy(() => import('./pages/Profile').then((m) => ({ default: m.Profile })))
const Configuration = lazy(() => import('./pages/Configuration').then((m) => ({ default: m.Configuration })))
const Referrals = lazy(() => import('./pages/Referrals').then((m) => ({ default: m.Referrals })))
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })))
const Gateway = lazy(() => import('./pages/Gateway').then((m) => ({ default: m.Gateway })))
const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })))
const Notifications = lazy(() => import('./pages/Notifications').then((m) => ({ default: m.Notifications })))
const MyAds = lazy(() => import('./pages/MyAds').then((m) => ({ default: m.MyAds })))

/** Branded page-level loading fallback shown while a lazy route loads. */
function PageFallback() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 py-24 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary via-primary to-accent shadow-glow">
        <Activity className="h-6 w-6 animate-pulse text-on-primary" strokeWidth={2.4} aria-hidden="true" />
      </div>
      <p className="text-sm text-muted-foreground">Loading ANA24…</p>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route element={<Layout />}>
            {/* Public */}
            <Route index element={<Home />} />
            <Route path="markets" element={<MarketPairs />} />
            <Route path="packages" element={<Packages />} />
            <Route path="brokers" element={<Brokers />} />
            <Route path="help" element={<Help />} />
            <Route path="contact" element={<Contact />} />
            <Route path="auth" element={<Auth />} />

            {/* App */}
            <Route path="trading" element={<TradingHub />} />
            <Route path="robots" element={<Robots />} />
            <Route path="performance" element={<Performance />} />
            <Route path="signals" element={<Signals />} />
            <Route path="backtester" element={<Backtester />} />
            <Route path="strategies" element={<Strategies />} />
            <Route path="account" element={<Account />} />
            <Route path="profile" element={<Profile />} />
            <Route path="configuration" element={<Configuration />} />
            <Route path="referrals" element={<Referrals />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="gateway" element={<Gateway />} />
            <Route path="admin" element={<Admin />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="my-ads" element={<MyAds />} />

            {/* Unknown paths → home (Layout's nav and footer link the real routes) */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  )
}
