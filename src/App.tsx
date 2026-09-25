/**
 * App — ANA24 routing + providers.
 *
 * The app shell (header, mobile nav, footer, global live-progress bar) lives in
 * Layout and wraps every route via its <Outlet />. Pages are auth-aware on
 * their own (they read useAuth and degrade gracefully for visitors), so routes
 * need no guard: anonymous visitors get the full public experience, signed-in
 * users get their workspace.
 *
 * /trading is served by TradingHub, which reads the `?robot=1..3` query param
 * and keeps every opened workspace mounted (running robots stay alive across
 * tab switches). Everything else maps one route to one page; unknown paths get
 * a friendly 404 inside the same shell.
 */
import { ArrowLeft } from 'lucide-react'
import { createBrowserRouter, Link, RouterProvider } from 'react-router-dom'
import Layout from './components/Layout'
import { AuthProvider } from './hooks/useAuth'
import { buttonClasses } from './components/ui'
import { Account } from './pages/Account'
import { Admin } from './pages/Admin'
import { Auth } from './pages/Auth'
import { Backtester } from './pages/Backtester'
import { Brokers } from './pages/Brokers'
import { Configuration } from './pages/Configuration'
import { Contact } from './pages/Contact'
import { Dashboard } from './pages/Dashboard'
import { Gateway } from './pages/Gateway'
import { Help } from './pages/Help'
import { Home } from './pages/Home'
import { MarketPairs } from './pages/MarketPairs'
import { MyAds } from './pages/MyAds'
import { Notifications } from './pages/Notifications'
import { Packages } from './pages/Packages'
import { Performance } from './pages/Performance'
import { Profile } from './pages/Profile'
import { Referrals } from './pages/Referrals'
import { Robots } from './pages/Robots'
import { Signals } from './pages/Signals'
import { Strategies } from './pages/Strategies'
import { TradingHub } from './pages/TradingHub'

function NotFound() {
  return (
    <div className="surface-premium mx-auto mt-16 max-w-md rounded-2xl border border-border/70 p-10 text-center">
      <p className="font-heading text-5xl font-bold tracking-tight text-foreground">404</p>
      <h1 className="mt-2 text-lg font-semibold text-foreground">That page slipped off the tape</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        The link you followed doesn't match any route in the terminal. Head back to the homepage and
        carry on.
      </p>
      <Link to="/" className={buttonClasses('primary', 'md', 'mt-6')}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to home
      </Link>
    </div>
  )
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'markets', element: <MarketPairs /> },
      { path: 'packages', element: <Packages /> },
      { path: 'brokers', element: <Brokers /> },
      { path: 'help', element: <Help /> },
      { path: 'contact', element: <Contact /> },
      { path: 'auth', element: <Auth /> },
      { path: 'trading', element: <TradingHub /> },
      { path: 'robots', element: <Robots /> },
      { path: 'performance', element: <Performance /> },
      { path: 'signals', element: <Signals /> },
      { path: 'backtester', element: <Backtester /> },
      { path: 'strategies', element: <Strategies /> },
      { path: 'account', element: <Account /> },
      { path: 'profile', element: <Profile /> },
      { path: 'configuration', element: <Configuration /> },
      { path: 'referrals', element: <Referrals /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'notifications', element: <Notifications /> },
      { path: 'my-ads', element: <MyAds /> },
      { path: 'admin', element: <Admin /> },
      { path: 'gateway', element: <Gateway /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  )
}
