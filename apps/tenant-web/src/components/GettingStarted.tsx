import { Link } from 'react-router-dom';
import { Check, UserPlus, CalendarPlus, ReceiptText } from 'lucide-react';

/**
 * The first-run checklist.
 *
 * A clinic evaluating this on a 7-day trial has one job on day one: get their
 * own patients into it. An empty app with a full menu does not tell them
 * where to start, and "I never got round to trying it" is the most common way
 * a trial dies.
 *
 * It disappears on its own. There is no dismiss button, because a card that
 * can be dismissed has to remember that it was — and the honest signal is
 * simply whether the work is done.
 */

export interface Progress {
  patients: number;
  appointments: number;
  invoices: number;
}

interface Step {
  key: keyof Progress;
  label: string;
  hint: string;
  cta: string;
  to: string;
  icon: typeof UserPlus;
}

const STEPS: Step[] = [
  {
    key: 'patients',
    label: 'Add your first patient',
    hint: 'Name and phone is enough — everything else can wait.',
    cta: 'Add patient',
    to: '/patients/new',
    icon: UserPlus,
  },
  {
    key: 'appointments',
    label: 'Book an appointment',
    hint: 'Click any slot in the calendar.',
    cta: 'Open calendar',
    to: '/reservations',
    icon: CalendarPlus,
  },
  {
    key: 'invoices',
    label: 'Create an invoice',
    hint: 'Bill a finished treatment and take a payment against it.',
    cta: 'New invoice',
    to: '/invoices',
    icon: ReceiptText,
  },
];

export default function GettingStarted({ progress }: { progress: Progress }) {
  const done = STEPS.filter((s) => progress[s.key] > 0).length;
  if (done === STEPS.length) return null;

  // Exactly one step is "next". Three primary buttons is not a checklist, it
  // is three competing calls to action and the reader picks none of them.
  const next = STEPS.find((s) => progress[s.key] === 0)!;

  return (
    <section className="start">
      <div className="start__head">
        <div>
          <h2 className="start__title">Set up your clinic</h2>
          <p className="start__sub">
            {done === 0
              ? 'Three steps to see the whole thing working.'
              : `${done} of ${STEPS.length} done — nearly there.`}
          </p>
        </div>
        <div className="start__progress" aria-hidden>
          {STEPS.map((s) => (
            <span
              key={s.key}
              className={`start__pip${progress[s.key] > 0 ? ' start__pip--done' : ''}`}
            />
          ))}
        </div>
      </div>

      <ol className="start__steps">
        {STEPS.map((s) => {
          const complete = progress[s.key] > 0;
          const isNext = s.key === next.key;
          const Icon = s.icon;
          return (
            <li
              className={`start__step${complete ? ' start__step--done' : ''}${
                isNext ? ' start__step--next' : ''
              }`}
              key={s.key}
            >
              <span className="start__mark">
                {complete ? <Check size={14} /> : <Icon size={15} />}
              </span>
              <span className="start__body">
                <span className="start__label">{s.label}</span>
                <span className="start__hint">{complete ? 'Done' : s.hint}</span>
              </span>
              {!complete && (
                <Link
                  to={s.to}
                  className={`btn ${isNext ? 'btn--primary' : 'btn--ghost btn--sm'}`}
                >
                  {s.cta}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
