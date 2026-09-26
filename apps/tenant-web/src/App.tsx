import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { AuthProvider, RequireAuth } from './lib/auth';
import { FeaturesProvider } from './lib/features';
import CashDrawerPage from './pages/CashDrawerPage';
import FiscalQueuePage from './pages/FiscalQueuePage';
import AppLayout from './components/AppLayout';
import LoginPage from './pages/LoginPage';
import AuthCallbackPage from './pages/AuthCallbackPage';
import DashboardPage from './pages/DashboardPage';
import PatientsListPage from './pages/PatientsListPage';
import PatientFormPage from './pages/PatientFormPage';
import PatientProfilePage from './pages/PatientProfilePage';
import PatientImportPage from './pages/PatientImportPage';
import ReservationsPage from './pages/ReservationsPage';
import TreatmentsPage from './pages/TreatmentsPage';
import StaffPage from './pages/StaffPage';
import RoomsPage from './pages/RoomsPage';
import InventoryPage from './pages/InventoryPage';
import SettingsPage from './pages/SettingsPage';
import ActivityPage from './pages/ActivityPage';
import InvoicesPage from './pages/InvoicesPage';
import InvoiceDetailPage, { PaymentsPage } from './pages/InvoiceDetailPage';
import ExpensesPage from './pages/ExpensesPage';
import ReportsPage from './pages/ReportsPage';
import FinancialsPage from './pages/FinancialsPage';
import FiscalReceiptPage from './pages/FiscalReceiptPage';
import MessagesPage from './pages/MessagesPage';
import EstimatePage from './pages/EstimatePage';

export default function App() {
  return (
    <AuthProvider>
      <FeaturesProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          {/* Documents to print: signed in, but without the app's chrome. */}
          <Route
            path="/invoices/:id/receipt"
            element={
              <RequireAuth>
                <FiscalReceiptPage />
              </RequireAuth>
            }
          />
          <Route
            path="/treatment-plans/:id/estimate"
            element={
              <RequireAuth>
                <EstimatePage />
              </RequireAuth>
            }
          />
          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/reservations" element={<ReservationsPage />} />
            <Route path="/messages" element={<MessagesPage />} />
            <Route path="/patients" element={<PatientsListPage />} />
            <Route path="/patients/new" element={<PatientFormPage />} />
            <Route path="/patients/import" element={<PatientImportPage />} />
            <Route path="/patients/:id" element={<PatientProfilePage />} />
            <Route path="/patients/:id/edit" element={<PatientFormPage />} />
            <Route path="/treatments" element={<TreatmentsPage />} />
            <Route path="/staff" element={<StaffPage />} />
            <Route path="/invoices" element={<InvoicesPage />} />
            <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/drawer" element={<CashDrawerPage />} />
            <Route path="/fiscal-queue" element={<FiscalQueuePage />} />
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/rooms" element={<RoomsPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/financials" element={<FinancialsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </FeaturesProvider>
    </AuthProvider>
  );
}
