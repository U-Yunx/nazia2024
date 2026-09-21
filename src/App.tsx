/**
 * ANA24 — app entry.
 *
 * Routes every page inside the shared chrome (sticky header + footer, see
 * src/components/Layout.tsx). The layout picks the nav set from auth state
 * (public links for visitors, app links for signed-in users), so the router
 * just declares the full route table and dips the whole tree in AuthProvider.
 *
 * Every page is lazy-loaded (code-split) so the initial payload stays small —
 * visitors on the landing page never download the trading UI and vice-versa.
 */
import { lazy, Suspense, type ComponentType } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { AuthProvider } from './hooks/useAuth'
import Layout from './components/Layout'

/** Lazily load a page module's named export for route-level code-splitting. */
function page<T extends Record<string, unknown>>(loader: () => Promise<T>, name: keyof T) {
  return lazy(async () => {
    const mod = await loader()
    return { default: mod[name] as ComponentType }
  })
}

const Home = page(() => import('./pages/Home'), 'Home')
const Auth = page(() => import('./pages/Auth'), 'Auth')
const MarketPairs = page(() => import('./pages/MarketPairs'), 'MarketPairs')
const Packages = page(() => import('./pages/Packages'), 'Packages')
const Brokers = page(() => import('./pages/Brokers'), 'Brokers')
const Help = page(() => import('./pages/Help'), 'Help')
const Contact = page(() => import('./pages/Contact'), 'Contact')
const Trading = page(() => import('./pages/TradingHub'), 'TradingHub')
const Robots = page(() => import('./pages/Robots'), 'Robots')
const Performance = page(() => import('./pages/Performance'), 'Performance')
const Signals = page(() => import('./pages/Signals'), 'Signals')
const Backtester = page(() => import('./pages/Backtester'), 'Backtester')
const Strategies = page(() => import('./pages/Strategies'), 'Strategies')
const Account = page(() => import('./pages/Account'), 'Account')
const Profile = page(() => import('./pages/Profile'), 'Profile')
const Configuration = page(() => import('./pages/Configuration'), 'Configuration')
const Notifications = page(() => import('./pages/Notifications'), 'Notifications')
const Referrals = page(() => import('./pages/Referrals'), 'Referrals')
const Gateway = page(() => import('./pages/Gateway'), 'Gateway')
const MyAds = page(() => import('./pages/MyAds'), 'MyAds')
const Dashboard = page(() => import('./pages/Dashboard'), 'Dashboard')
const Admin = page(() => import('./pages/Admin'), 'Admin')

function PageFallback() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" role="status" aria-label="Loading page">
      <Loader2 className="h-6 w-6 animate-spin text-accent" aria-hidden="true" />
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
              <Route path="/" element={<Home />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/markets" element={<MarketPairs />} />
              <Route path="/packages" element={<Packages />} />
              <Route path="/brokers" element={<Brokers />} />
              <Route path="/help" element={<Help />} />
              <Route path="/contact" element={<Contact />} />
              <Route path="/trading" element={<Trading />} />
              <Route path="/robots" element={<Robots />} />
              <Route path="/performance" element={<Performance />} />
              <Route path="/signals" element={<Signals />} />
              <Route path="/backtester" element={<Backtester />} />
              <Route path="/strategies" element={<Strategies />} />
              <Route path="/account" element={<Account />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/configuration" element={<Configuration />} />
              <Route path="/notifications" element={<Notifications />} />
              <Route path="/referrals" element={<Referrals />} />
              <Route path="/gateway" element={<Gateway />} />
              <Route path="/my-ads" element={<MyAds />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="*" element={<Home />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  )
}