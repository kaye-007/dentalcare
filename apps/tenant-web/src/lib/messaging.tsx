import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import type { MessagePurpose } from '@dentalcare/shared';

const MessageSheet = lazy(() => import('../components/MessageSheet'));

export interface MessageRequest {
  patientId: string;
  patientName: string;
  purpose?: MessagePurpose;
  appointmentId?: string;
  invoiceId?: string;
}
type OpenMessage = (request: MessageRequest) => void;

const MessagingCtx = createContext<OpenMessage | null>(null);

/**
 * One way to message a patient, from wherever the work is: the record, a
 * visit ("Send a reminder"), an unpaid invoice ("Remind about the balance").
 * The sheet opens over the page, not inside another panel, so it has the
 * screen — and the Escape key — to itself.
 */
export function MessagingProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<MessageRequest | null>(null);
  const open = useCallback<OpenMessage>((r) => setRequest(r), []);
  return (
    <MessagingCtx.Provider value={open}>
      {children}
      {request && (
        <Suspense fallback={null}>
          <MessageSheet {...request} onClose={() => setRequest(null)} />
        </Suspense>
      )}
    </MessagingCtx.Provider>
  );
}

/** Open the message sheet; outside the provider it does nothing. */
export function useMessaging(): OpenMessage {
  return useContext(MessagingCtx) ?? (() => undefined);
}
