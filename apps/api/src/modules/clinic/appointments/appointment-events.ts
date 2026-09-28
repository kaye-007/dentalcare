import { Injectable, Logger } from '@nestjs/common';

/**
 * Appointment lifecycle events.
 *
 * Phase 3 needs a seam where "something happened to an appointment" can be
 * observed without the scheduling service knowing who cares. Reminders want
 * it now; Phase 5 billing will want `appointment.status_changed` to
 * `completed` in order to raise an invoice, and neither should require
 * editing AppointmentsService.
 *
 * Deliberately in-process and synchronous-ish: this is a single-instance API
 * with a resident scheduler, so a queue would be infrastructure without a
 * problem to solve. The contract is narrow enough to put behind a real broker
 * later without touching a single call site.
 *
 * A listener that throws must never fail the booking that triggered it — the
 * appointment is the fact, the notification is a consequence. Errors are
 * logged and swallowed per-listener.
 */

export interface AppointmentSnapshot {
  id: string;
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  patientEmail: string | null;
  staffId: string | null;
  staffName: string | null;
  operatoryId: string | null;
  operatoryName: string | null;
  reason: string;
  status: string;
  startsAt: string;
  endsAt: string;
}

export type AppointmentEvent =
  | { type: 'appointment.created'; appointment: AppointmentSnapshot; actorId: string }
  | { type: 'appointment.updated'; appointment: AppointmentSnapshot; actorId: string }
  | {
      type: 'appointment.rescheduled';
      appointment: AppointmentSnapshot;
      actorId: string;
      previous: { startsAt: string; endsAt: string };
    }
  | {
      type: 'appointment.status_changed';
      appointment: AppointmentSnapshot;
      actorId: string;
      from: string;
      to: string;
    };

export type AppointmentEventType = AppointmentEvent['type'];
export type AppointmentListener = (event: AppointmentEvent) => void | Promise<void>;

@Injectable()
export class AppointmentEvents {
  private readonly log = new Logger(AppointmentEvents.name);
  private readonly listeners = new Map<
    AppointmentEventType | '*',
    AppointmentListener[]
  >();

  /** Subscribe to one event type, or '*' for all of them. */
  on(type: AppointmentEventType | '*', listener: AppointmentListener): void {
    const existing = this.listeners.get(type);
    if (existing) existing.push(listener);
    else this.listeners.set(type, [listener]);
  }

  /**
   * Notify every listener. Awaited so a listener that writes to the database
   * finishes before the HTTP response is sent, but isolated so one failure
   * cannot roll back or fail the caller.
   */
  async emit(event: AppointmentEvent): Promise<void> {
    const listeners = [
      ...(this.listeners.get(event.type) ?? []),
      ...(this.listeners.get('*') ?? []),
    ];
    for (const listener of listeners) {
      try {
        await listener(event);
      } catch (err) {
        this.log.error(
          `Listener for ${event.type} failed (appointment ${event.appointment.id}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /** Test/diagnostic helper: how many listeners are attached to a type. */
  listenerCount(type: AppointmentEventType | '*'): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}
