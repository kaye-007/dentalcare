import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Pill, Activity, Plus, X, Check } from 'lucide-react';
import {
  historyApi,
  type Allergy,
  type AllergySeverity,
  type Condition,
  type Medication,
  type MedicalHistory,
  humanError,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { StatusPill, LoadingRows } from './ui';
import { WithdrawModal } from './VoidModal';

/**
 * Allergies, conditions and current medications for one patient.
 *
 * The severe-allergy banner is the reason this component exists. It is
 * rendered before anything else and is not collapsible: a dentist about to
 * administer anaesthetic must not be able to miss it.
 *
 * Nothing here is deleted. A condition that got better is resolved and a
 * medication that stopped is ended — both facts about the patient. An entry
 * that was simply wrong is withdrawn as entered in error, with a reason.
 */

const SEVERITY_ORDER: Record<AllergySeverity, number> = {
  severe: 0,
  moderate: 1,
  mild: 2,
};

const SEVERITY_LABEL: Record<AllergySeverity, string> = {
  severe: 'Severe',
  moderate: 'Moderate',
  mild: 'Mild',
};

export default function MedicalHistoryCard({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  // Intake history is its own grant: reception takes it without being able to
  // touch the chart.
  const canEdit = can('history:write');

  const [data, setData] = useState<MedicalHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<'allergy' | 'condition' | 'medication' | null>(
    null,
  );

  const load = useCallback(() => {
    historyApi
      .summary(patientId)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(humanError(e)));
  }, [patientId]);

  useEffect(load, [load]);

  if (error) {
    return (
      <section className="card card--record">
        <p className="formerror">Could not load medical history: {error}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="card card--record">
        <LoadingRows rows={3} label="Loading medical history" />
      </section>
    );
  }

  const severe = data.allergies.filter((a) => a.severity === 'severe');
  const sortedAllergies = [...data.allergies].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.substance.localeCompare(b.substance),
  );
  const activeConditions = data.conditions.filter((c) => c.status === 'active');
  const resolvedConditions = data.conditions.filter((c) => c.status === 'resolved');
  const current = data.medications.filter((m) => m.isCurrent);
  const past = data.medications.filter((m) => !m.isCurrent);

  return (
    <>
      {severe.length > 0 && (
        <div className="alertbanner" role="alert">
          <AlertTriangle size={20} aria-hidden />
          <div>
            <strong>Severe allergy — {severe.map((a) => a.substance).join(', ')}</strong>
            {severe.some((a) => a.reaction) && (
              <p>
                {severe
                  .filter((a) => a.reaction)
                  .map((a) => `${a.substance}: ${a.reaction}`)
                  .join(' · ')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* One card, three short sections: an empty history is three quiet
          lines, not three boxes each announcing that nothing is there. */}
      <section className="card card--record medhistory" aria-labelledby="medhistory-head">
        <header className="card__head">
          <h3 id="medhistory-head">Medical history</h3>
        </header>

        {/* ── allergies ── */}
        <div className="medsec">
          <header className="medsec__head">
            <h4>
              <AlertTriangle size={15} aria-hidden /> Allergies
            </h4>
            {canEdit && adding !== 'allergy' && (
              <button
                className="btn btn--quiet btn--sm"
                onClick={() => setAdding('allergy')}
                aria-label="Add an allergy"
              >
                <Plus size={14} aria-hidden /> Add
              </button>
            )}
          </header>

          {adding === 'allergy' && (
            <AllergyForm
              patientId={patientId}
              onDone={() => {
                setAdding(null);
                load();
              }}
              onCancel={() => setAdding(null)}
            />
          )}

          {sortedAllergies.length === 0 && adding !== 'allergy' ? (
            <p className="medsec__none">No known allergies</p>
          ) : (
            <ul className="recordlist">
              {sortedAllergies.map((a) => (
                <AllergyRow
                  key={a.id}
                  allergy={a}
                  patientId={patientId}
                  canEdit={canEdit}
                  onChange={load}
                />
              ))}
            </ul>
          )}
        </div>

        {/* ── conditions ── */}
        <div className="medsec">
          <header className="medsec__head">
            <h4>
              <Activity size={15} aria-hidden /> Conditions
            </h4>
            {canEdit && adding !== 'condition' && (
              <button
                className="btn btn--quiet btn--sm"
                onClick={() => setAdding('condition')}
                aria-label="Add a condition"
              >
                <Plus size={14} aria-hidden /> Add
              </button>
            )}
          </header>

          {adding === 'condition' && (
            <ConditionForm
              patientId={patientId}
              onDone={() => {
                setAdding(null);
                load();
              }}
              onCancel={() => setAdding(null)}
            />
          )}

          {data.conditions.length === 0 && adding !== 'condition' ? (
            <p className="medsec__none">None recorded</p>
          ) : (
            <ul className="recordlist">
              {[...activeConditions, ...resolvedConditions].map((c) => (
                <ConditionRow
                  key={c.id}
                  condition={c}
                  patientId={patientId}
                  canEdit={canEdit}
                  onChange={load}
                />
              ))}
            </ul>
          )}
        </div>

        {/* ── medications ── */}
        <div className="medsec">
          <header className="medsec__head">
            <h4>
              <Pill size={15} aria-hidden /> Medications
            </h4>
            {canEdit && adding !== 'medication' && (
              <button
                className="btn btn--quiet btn--sm"
                onClick={() => setAdding('medication')}
                aria-label="Add a medication"
              >
                <Plus size={14} aria-hidden /> Add
              </button>
            )}
          </header>

          {adding === 'medication' && (
            <MedicationForm
              patientId={patientId}
              onDone={() => {
                setAdding(null);
                load();
              }}
              onCancel={() => setAdding(null)}
            />
          )}

          {data.medications.length === 0 && adding !== 'medication' ? (
            <p className="medsec__none">None recorded</p>
          ) : (
            <ul className="recordlist">
              {[...current, ...past].map((m) => (
                <MedicationRow
                  key={m.id}
                  medication={m}
                  patientId={patientId}
                  canEdit={canEdit}
                  onChange={load}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}

/* ══════════════════════════ rows ══════════════════════════ */

function AllergyRow({
  allergy,
  patientId,
  canEdit,
  onChange,
}: {
  allergy: Allergy;
  patientId: string;
  canEdit: boolean;
  onChange: () => void;
}) {
  const [withdrawing, setWithdrawing] = useState(false);

  return (
    <li className="recordrow">
      <div className="recordrow__main">
        <span className="recordrow__title">{allergy.substance}</span>
        <StatusPill status={allergy.severity} label={SEVERITY_LABEL[allergy.severity]} />
        {allergy.reaction && <span className="cell-sub">{allergy.reaction}</span>}
        {allergy.notes && <p className="muted recordrow__note">{allergy.notes}</p>}
      </div>
      {canEdit && (
        <button
          className="iconbtn"
          onClick={() => setWithdrawing(true)}
          title="Withdraw as entered in error"
          aria-label={`Withdraw allergy to ${allergy.substance} as entered in error`}
        >
          <X size={15} />
        </button>
      )}
      {withdrawing && (
        <WithdrawModal
          what={`the allergy to ${allergy.substance}`}
          onClose={() => setWithdrawing(false)}
          onConfirm={async (reason) => {
            await historyApi.withdrawAllergy(patientId, allergy.id, reason);
            setWithdrawing(false);
            onChange();
          }}
        />
      )}
    </li>
  );
}

function ConditionRow({
  condition,
  patientId,
  canEdit,
  onChange,
}: {
  condition: Condition;
  patientId: string;
  canEdit: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(humanError(e));
      setBusy(false);
    }
  };

  return (
    <li
      className={`recordrow${condition.status === 'resolved' ? ' recordrow--muted' : ''}`}
    >
      <div className="recordrow__main">
        <span className="recordrow__title">{condition.name}</span>
        <StatusPill status={condition.status} />
        {condition.diagnosedOn && (
          <span className="cell-sub">Diagnosed {condition.diagnosedOn}</span>
        )}
        {condition.notes && <p className="muted recordrow__note">{condition.notes}</p>}
        {err && <p className="formerror">{err}</p>}
      </div>
      {canEdit && (
        <div className="recordrow__actions">
          {condition.status === 'active' && (
            <button
              className="iconbtn"
              disabled={busy}
              aria-label={`Mark ${condition.name} resolved`}
              onClick={() =>
                act(() =>
                  historyApi.updateCondition(patientId, condition.id, {
                    status: 'resolved',
                  }),
                )
              }
            >
              <Check size={15} />
            </button>
          )}
          <button
            className="iconbtn"
            disabled={busy}
            title="Withdraw as entered in error"
            aria-label={`Withdraw ${condition.name} as entered in error`}
            onClick={() => setWithdrawing(true)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {withdrawing && (
        <WithdrawModal
          what={`the condition “${condition.name}”`}
          onClose={() => setWithdrawing(false)}
          onConfirm={async (reason) => {
            await historyApi.withdrawCondition(patientId, condition.id, reason);
            setWithdrawing(false);
            onChange();
          }}
        />
      )}
    </li>
  );
}

function MedicationRow({
  medication,
  patientId,
  canEdit,
  onChange,
}: {
  medication: Medication;
  patientId: string;
  canEdit: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(humanError(e));
      setBusy(false);
    }
  };

  const detail = [medication.dosage, medication.frequency].filter(Boolean).join(' · ');

  return (
    <li className={`recordrow${medication.isCurrent ? '' : ' recordrow--muted'}`}>
      <div className="recordrow__main">
        <span className="recordrow__title">{medication.name}</span>
        <StatusPill status={medication.isCurrent ? 'current' : 'stopped'} />
        {detail && <span className="cell-sub">{detail}</span>}
        {(medication.startedOn || medication.endedOn) && (
          <span className="cell-sub">
            {medication.startedOn ?? '?'} → {medication.endedOn ?? 'ongoing'}
          </span>
        )}
        {medication.notes && <p className="muted recordrow__note">{medication.notes}</p>}
        {err && <p className="formerror">{err}</p>}
      </div>
      {canEdit && (
        <div className="recordrow__actions">
          {medication.isCurrent && (
            <button
              className="iconbtn"
              disabled={busy}
              aria-label={`Stop ${medication.name}`}
              onClick={() =>
                act(() =>
                  historyApi.updateMedication(patientId, medication.id, {
                    endedOn: new Date().toISOString().slice(0, 10),
                  }),
                )
              }
            >
              <Check size={15} />
            </button>
          )}
          <button
            className="iconbtn"
            disabled={busy}
            title="Withdraw as entered in error"
            aria-label={`Withdraw ${medication.name} as entered in error`}
            onClick={() => setWithdrawing(true)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {withdrawing && (
        <WithdrawModal
          what={`the medication ${medication.name}`}
          onClose={() => setWithdrawing(false)}
          onConfirm={async (reason) => {
            await historyApi.withdrawMedication(patientId, medication.id, reason);
            setWithdrawing(false);
            onChange();
          }}
        />
      )}
    </li>
  );
}

/* ══════════════════════════ forms ══════════════════════════ */

function AllergyForm({
  patientId,
  onDone,
  onCancel,
}: {
  patientId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [substance, setSubstance] = useState('');
  const [severity, setSeverity] = useState<AllergySeverity>('moderate');
  const [reaction, setReaction] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!substance.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await historyApi.createAllergy(patientId, {
        substance: substance.trim(),
        severity,
        reaction: reaction.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onDone();
    } catch (e2) {
      setErr(humanError(e2));
      setBusy(false);
    }
  };

  return (
    <form className="inlineform" onSubmit={submit}>
      <div className="grid2">
        <label className="field">
          <span>Substance</span>
          <input
            value={substance}
            onChange={(e) => setSubstance(e.target.value)}
            placeholder="Penicillin, latex, local anaesthetic…"
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span>Severity</span>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as AllergySeverity)}
          >
            <option value="mild">Mild</option>
            <option value="moderate">Moderate</option>
            <option value="severe">Severe</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Reaction</span>
        <input
          value={reaction}
          onChange={(e) => setReaction(e.target.value)}
          placeholder="Anaphylaxis, rash, swelling…"
        />
      </label>
      <label className="field">
        <span>Notes</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {err && <p className="formerror">{err}</p>}
      <div className="inlineform__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy}>
          {busy ? 'Saving…' : 'Add allergy'}
        </button>
      </div>
    </form>
  );
}

function ConditionForm({
  patientId,
  onDone,
  onCancel,
}: {
  patientId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [diagnosedOn, setDiagnosedOn] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await historyApi.createCondition(patientId, {
        name: name.trim(),
        status: 'active',
        diagnosedOn: diagnosedOn || undefined,
        notes: notes.trim() || undefined,
      });
      onDone();
    } catch (e2) {
      setErr(humanError(e2));
      setBusy(false);
    }
  };

  return (
    <form className="inlineform" onSubmit={submit}>
      <div className="grid2">
        <label className="field">
          <span>Condition</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Diabetes, hypertension, epilepsy…"
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span>Diagnosed on</span>
          <input
            type="date"
            value={diagnosedOn}
            onChange={(e) => setDiagnosedOn(e.target.value)}
          />
        </label>
      </div>
      <label className="field">
        <span>Notes</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {err && <p className="formerror">{err}</p>}
      <div className="inlineform__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy}>
          {busy ? 'Saving…' : 'Add condition'}
        </button>
      </div>
    </form>
  );
}

function MedicationForm({
  patientId,
  onDone,
  onCancel,
}: {
  patientId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [dosage, setDosage] = useState('');
  const [frequency, setFrequency] = useState('');
  const [startedOn, setStartedOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await historyApi.createMedication(patientId, {
        name: name.trim(),
        dosage: dosage.trim() || undefined,
        frequency: frequency.trim() || undefined,
        startedOn: startedOn || undefined,
      });
      onDone();
    } catch (e2) {
      setErr(humanError(e2));
      setBusy(false);
    }
  };

  return (
    <form className="inlineform" onSubmit={submit}>
      <div className="grid2">
        <label className="field">
          <span>Medication</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Warfarin, bisphosphonate…"
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span>Dosage</span>
          <input
            value={dosage}
            onChange={(e) => setDosage(e.target.value)}
            placeholder="5 mg"
          />
        </label>
      </div>
      <div className="grid2">
        <label className="field">
          <span>Frequency</span>
          <input
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            placeholder="Once daily"
          />
        </label>
        <label className="field">
          <span>Started on</span>
          <input
            type="date"
            value={startedOn}
            onChange={(e) => setStartedOn(e.target.value)}
          />
        </label>
      </div>
      {err && <p className="formerror">{err}</p>}
      <div className="inlineform__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy}>
          {busy ? 'Saving…' : 'Add medication'}
        </button>
      </div>
    </form>
  );
}
