/**
 * ANA24 — app entry & routing.
 *
 * Every route renders inside <Layout />, which provides the sticky header
 * (auth-aware nav), the ambient background and the footer. The AuthProvider
 * sits above the router so pages can read the signed-in user anywhere.
 *
 * Nav behaviour: visitors see the public menu; signed-in users see the app
 * menu. The home route shows the public landing page (its CTAs adapt to the
 * session state) and the signed-in dashboard lives at /dashboard.
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import Layout from './components/Layout'
import { Home } from './pages/Home'
import { Dashboard } from './pages/Dashboard'
import { MarketPairs } from './pages/MarketPairs'
import { Packages } from './pages/Packages'
import { Brokers } from './pages/Brokers'
import { Help } from './pages/Help'
import { Contact } from './pages/Contact'
import { Auth } from './pages/Auth'
import { TradingHub } from './pages/TradingHub'
import { Robots } from './pages/Robots'
import { Performance } from './pages/Performance'
import { Signals } from './pages/Signals'
import { Backtester } from './pages/Backtester'
import { Strategies } from './pages/Strategies'
import { Account } from './pages/Account'
import { Profile } from './pages/Profile'
import { Configuration } from './pages/Configuration'
import { Referrals } from './pages/Referrals'
import { Gateway } from './pages/Gateway'
import { Notifications } from './pages/Notifications'
import { MyAds } from './pages/MyAds'
import { Admin } from './pages/Admin'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="markets" element={<MarketPairs />} />
            <Route path="packages" element={<Packages />} />
            <Route path="brokers" element={<Brokers />} />
            <Route path="help" element={<Help />} />
            <Route path="contact" element={<Contact />} />
            <Route path="auth" element={<Auth />} />
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
            <Route path="gateway" element={<Gateway />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="my-ads" element={<MyAds />} />
            <Route path="admin" element={<Admin />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}