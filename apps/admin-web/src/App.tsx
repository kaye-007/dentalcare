import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './lib/auth';
import { ConfirmProvider, ToastProvider } from './components/ui';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import AuthCallbackPage from './pages/AuthCallbackPage';
import OverviewPage from './pages/OverviewPage';
import TenantsPage from './pages/TenantsPage';
import TenantDetailPage from './pages/TenantDetailPage';
import BillingPage from './pages/BillingPage';
import PlansPage from './pages/PlansPage';
import UsagePage from './pages/UsagePage';
import ActivityPage from './pages/ActivityPage';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <ToastProvider>
          <ConfirmProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/auth/callback" element={<AuthCallbackPage />} />
              <Route
                element={
                  <RequireAuth>
                    <Layout />
                  </RequireAuth>
                }
              >
                <Route path="/" element={<OverviewPage />} />
                <Route path="/clinics" element={<TenantsPage />} />
                <Route path="/tenants/:id" element={<TenantDetailPage />} />
                <Route path="/billing" element={<BillingPage />} />
                <Route path="/plans" element={<PlansPage />} />
                <Route path="/usage" element={<UsagePage />} />
                <Route path="/activity" element={<ActivityPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ConfirmProvider>
        </ToastProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}
