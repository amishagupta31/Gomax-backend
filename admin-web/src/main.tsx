import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import './styles.css';
import { AuthProvider, useAuth } from './auth';
import { can } from './roles';
import Shell from './Shell';
import { ToastProvider } from './ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Applicators from './pages/Applicators';
import ApplicatorProfile from './pages/ApplicatorProfile';
import Coupons from './pages/Coupons';
import Scans from './pages/Scans';
import Withdrawals from './pages/Withdrawals';
import Gifts from './pages/Gifts';
import Referrals from './pages/Referrals';
import Dealers from './pages/Dealers';
import Games from './pages/Games';
import Challenges from './pages/Challenges';
import Content from './pages/Content';
import WhatsApp from './pages/WhatsApp';
import Products from './pages/Products';
import Settings from './pages/Settings';
import Audit from './pages/Audit';
import { MobileApprovals, MobileCoupons, MobileMe } from './pages/Mobile';

/** Hides pages the role can't open (D0 table); the API checks again on every call. */
function Gate({ path, children }: { path: string; children: ReactNode }) {
  const { staff } = useAuth();
  return staff && can(staff.role, path) ? children : <Navigate to="/" replace />;
}

function App() {
  const { staff, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return null;
  if (!staff) return <Login />;
  const g = (path: string, el: ReactNode) => <Gate path={path}>{el}</Gate>;
  return (
    <Routes location={loc}>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="applicators" element={g('/applicators', <Applicators />)} />
        <Route path="applicators/:id" element={g('/applicators', <ApplicatorProfile />)} />
        <Route path="coupons" element={g('/coupons', <Coupons />)} />
        <Route path="scans" element={g('/scans', <Scans />)} />
        <Route path="withdrawals" element={g('/withdrawals', <Withdrawals />)} />
        <Route path="gifts" element={g('/gifts', <Gifts />)} />
        <Route path="referrals" element={g('/referrals', <Referrals />)} />
        <Route path="dealers" element={g('/dealers', <Dealers />)} />
        <Route path="games" element={g('/games', <Games />)} />
        <Route path="challenges" element={g('/challenges', <Challenges />)} />
        <Route path="content" element={g('/content', <Content />)} />
        <Route path="whatsapp" element={g('/whatsapp', <WhatsApp />)} />
        <Route path="products" element={g('/products', <Products />)} />
        <Route path="settings" element={g('/settings', <Settings />)} />
        <Route path="audit" element={g('/audit', <Audit />)} />
        <Route path="m/approvals" element={<MobileApprovals />} />
        <Route path="m/coupons" element={<MobileCoupons />} />
        <Route path="m/me" element={<MobileMe />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
