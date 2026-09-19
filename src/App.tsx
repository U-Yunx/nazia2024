/**
 * ANA24 — app entry.
 *
 * Routes every page inside the shared chrome (sticky header + footer, see
 * src/components/Layout.tsx). The layout picks the nav set from auth state
 * (public links for visitors, app links for signed-in users), so the router
 * just declares the full route table and dips the whole tree in AuthProvider.
 */
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import Layout from './components/Layout'
import { Home } from './pages/Home'
import { Auth } from './pages/Auth'
import { MarketPairs } from './pages/MarketPairs'
import { Packages } from './pages/Packages'
import { Brokers } from './pages/Brokers'
import { Help } from './pages/Help'
import { Contact } from './pages/Contact'
import { Trading } from './pages/Trading'
import { Performance } from './pages/Performance'
import { Signals } from './pages/Signals'
import { Backtester } from './pages/Backtester'
import { Strategies } from './pages/Strategies'
import { Account } from './pages/Account'
import { Profile } from './pages/Profile'
import { Configuration } from './pages/Configuration'
import { Notifications } from './pages/Notifications'
import { Referrals } from './pages/Referrals'
import { Gateway } from './pages/Gateway'
import { MyAds } from './pages/MyAds'
import { Dashboard } from './pages/Dashboard'
import { Admin } from './pages/Admin'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
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
      </BrowserRouter>
    </AuthProvider>
  )
}