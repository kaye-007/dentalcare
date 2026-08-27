import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { I18nProvider } from './lib/i18n';
import { AuthProvider, RequireAuth } from './lib/auth';
import AppLayout from './components/AppLayout';
import LoginPage from './pages/LoginPage';
import AuthCallbackPage from './pages/AuthCallbackPage';
import DashboardPage from './pages/DashboardPage';
import PatientsListPage from './pages/PatientsListPage';
import PatientFormPage from './pages/PatientFormPage';
import PatientProfilePage from './pages/PatientProfilePage';
import ReservationsPage from './pages/ReservationsPage';
import TreatmentsPage from './pages/TreatmentsPage';
import StaffPage from './pages/StaffPage';
import RoomsPage from './pages/RoomsPage';
import SettingsPage from './pages/SettingsPage';
import ActivityPage from './pages/ActivityPage';
import InvoicesPage from './pages/InvoicesPage';
import InvoiceDetailPage, { PaymentsPage } from './pages/InvoiceDetailPage';
import ExpensesPage from './pages/ExpensesPage';
import ReportsPage from './pages/ReportsPage';
import FinancialsPage from './pages/FinancialsPage';

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
      <BrowserRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/reservations" element={<ReservationsPage />} />
            <Route path="/patients" element={<PatientsListPage />} />
            <Route path="/patients/new" element={<PatientFormPage />} />
            <Route path="/patients/:id" element={<PatientProfilePage />} />
            <Route path="/patients/:id/edit" element={<PatientFormPage />} />
            <Route path="/treatments" element={<TreatmentsPage />} />
            <Route path="/staff" element={<StaffPage />} />
            <Route path="/invoices" element={<InvoicesPage />} />
            <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/rooms" element={<RoomsPage />} />
            <Route path="/financials" element={<FinancialsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </AuthProvider>
    </I18nProvider>
  );
}
