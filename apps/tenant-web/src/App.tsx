import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { AuthProvider, RequireAuth } from './lib/auth';
import { FeaturesProvider } from './lib/features';
import AppLayout from './components/AppLayout';
import LoginPage from './pages/LoginPage';
import AuthCallbackPage from './pages/AuthCallbackPage';
// The first download is the shell, sign-in and the dashboard every role
// lands on. Each other screen arrives the first time it is opened (see
// AppLayout's Suspense) and is cached from then on, which keeps the first
// load small on a phone connection.
import DashboardPage from './pages/DashboardPage';

const PatientsListPage = lazy(() => import('./pages/PatientsListPage'));
const PatientProfilePage = lazy(() => import('./pages/PatientProfilePage'));
const ReservationsPage = lazy(() => import('./pages/ReservationsPage'));
const ClinicalPage = lazy(() => import('./pages/ClinicalPage'));

const PatientFormPage = lazy(() => import('./pages/PatientFormPage'));
const PatientImportPage = lazy(() => import('./pages/PatientImportPage'));
const RecallPage = lazy(() => import('./pages/RecallPage'));
const CashDrawerPage = lazy(() => import('./pages/CashDrawerPage'));
const FiscalQueuePage = lazy(() => import('./pages/FiscalQueuePage'));
const TreatmentsPage = lazy(() => import('./pages/TreatmentsPage'));
const StaffPage = lazy(() => import('./pages/StaffPage'));
const RoomsPage = lazy(() => import('./pages/RoomsPage'));
const InventoryPage = lazy(() => import('./pages/InventoryPage'));
const LabPage = lazy(() => import('./pages/LabPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const ActivityPage = lazy(() => import('./pages/ActivityPage'));
const InvoicesPage = lazy(() => import('./pages/InvoicesPage'));
const InvoiceDetailPage = lazy(() => import('./pages/InvoiceDetailPage'));
const PaymentsPage = lazy(() =>
  import('./pages/InvoiceDetailPage').then((m) => ({ default: m.PaymentsPage })),
);
const ExpensesPage = lazy(() => import('./pages/ExpensesPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const FinancialsPage = lazy(() => import('./pages/FinancialsPage'));
const FiscalReceiptPage = lazy(() => import('./pages/FiscalReceiptPage'));
const MessagesPage = lazy(() => import('./pages/MessagesPage'));
const EstimatePage = lazy(() => import('./pages/EstimatePage'));
import { ConfirmProvider, PageLoading, ToastProvider } from './components/ui';

export default function App() {
  return (
    <AuthProvider>
      <FeaturesProvider>
      <ToastProvider>
      <ConfirmProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          {/* Documents to print: signed in, but without the app's chrome. */}
          <Route
            path="/invoices/:id/receipt"
            element={
              <RequireAuth>
                <Suspense fallback={<PageLoading />}>
                  <FiscalReceiptPage />
                </Suspense>
              </RequireAuth>
            }
          />
          <Route
            path="/treatment-plans/:id/estimate"
            element={
              <RequireAuth>
                <Suspense fallback={<PageLoading />}>
                  <EstimatePage />
                </Suspense>
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
            <Route path="/messages/:tab" element={<MessagesPage />} />
            <Route path="/patients" element={<PatientsListPage />} />
            <Route path="/patients/new" element={<PatientFormPage />} />
            <Route path="/patients/import" element={<PatientImportPage />} />
            <Route path="/patients/recall" element={<RecallPage />} />
            <Route path="/patients/:id" element={<PatientProfilePage />} />
            <Route path="/patients/:id/edit" element={<PatientFormPage />} />
            <Route path="/clinical" element={<ClinicalPage />} />
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
            <Route path="/lab" element={<LabPage />} />
            <Route path="/financials" element={<FinancialsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </ConfirmProvider>
      </ToastProvider>
      </FeaturesProvider>
    </AuthProvider>
  );
}
