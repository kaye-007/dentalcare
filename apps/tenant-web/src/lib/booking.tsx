import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import type { Appointment } from './api';

const AppointmentModal = lazy(() => import('../components/AppointmentModal'));

/**
 * What the booking panel is opened with. Whatever the place it is opened from
 * already knows — the patient on their record, the service found in search —
 * is passed in, so the panel never asks for it again.
 */
export interface BookingRequest {
  patientId?: string;
  staffId?: string;
  treatmentId?: string;
  /** An existing visit, opened on its free times (Move). */
  move?: Appointment;
  /** Called after a booking or a move, to refresh the page behind. */
  onSaved?: () => void;
}
type OpenBooking = (request?: BookingRequest) => void;

const BookingCtx = createContext<OpenBooking | null>(null);

/**
 * One "Book appointment" for the whole app. The dashboard, a patient's record,
 * the recall list and search all open the same panel over the page they are
 * on, instead of sending the desk to the calendar and back.
 */
export function BookingProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<BookingRequest | null>(null);
  const open = useCallback<OpenBooking>((r) => setRequest(r ?? {}), []);
  return (
    <BookingCtx.Provider value={open}>
      {children}
      {request && (
        <Suspense fallback={null}>
          <AppointmentModal
            initialPatientId={request.patientId}
            initialStaffId={request.staffId}
            initialTreatmentId={request.treatmentId}
            appointment={request.move}
            startWith={request.move ? 'move' : undefined}
            offerView
            onClose={() => setRequest(null)}
            onSaved={() => {
              setRequest(null);
              request.onSaved?.();
            }}
          />
        </Suspense>
      )}
    </BookingCtx.Provider>
  );
}

/**
 * Open the booking panel. Outside the provider (a page rendered on its own),
 * it falls back to the calendar's own panel.
 */
export function useBooking(): OpenBooking {
  const open = useContext(BookingCtx);
  const navigate = useNavigate();
  return (
    open ??
    ((r) =>
      navigate(
        `/reservations?new=1${r?.patientId ? `&patient=${encodeURIComponent(r.patientId)}` : ''}`,
      ))
  );
}
