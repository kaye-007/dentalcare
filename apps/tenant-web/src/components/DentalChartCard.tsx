import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Activity, Plus, X, Check, RotateCcw } from 'lucide-react';
import {
  ApiError,
  chartApi,
  TOOTH_CONDITIONS,
  WHOLE_TOOTH_CONDITIONS,
  type DentalChart,
  type Surface,
  type ToothCondition,
  type ToothConditionRecord,
} from '../lib/api';
import {
  FAMILY_KEYS,
  conditionStyle,
  surfaceName,
  surfacesFor,
  toothLabel,
  type ConditionFamily,
  type Dentition,
  type Notation,
} from '../lib/tooth-notation';
import { useAuth } from '../lib/auth';
import { EmptyState, StatusPill } from './ui';
import Odontogram, { ConditionSwatch } from './Odontogram';
import { dateLocale } from '../lib/i18n';
import { useT } from '../lib/i18n';

/**
 * The odontogram plus the finding list for the selected tooth.
 *
 * Notation and dentition are view state, not data: the chart is always stored
 * in FDI, and a clinician switching to Universal or to the primary arch is
 * changing how they read it, not what was recorded.
 */
export default function DentalChartCard({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  const canEdit = can('clinical:write');

  const [chart, setChart] = useState<DentalChart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dentition, setDentition] = useState<Dentition>('permanent');
  const [notation, setNotation] = useState<Notation>('fdi');
  const [selected, setSelected] = useState<number | null>(null);
  const [preselectSurface, setPreselectSurface] = useState<Surface | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    chartApi
      .get(patientId)
      .then((c) => { setChart(c); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, [patientId]);

  useEffect(load, [load]);

  const pickTooth = (t: number) => {
    setSelected(t);
    setPreselectSurface(null);
    setAdding(false);
  };
  const pickSurface = (t: number, s: Surface) => {
    setSelected(t);
    setPreselectSurface(s);
    if (canEdit) setAdding(true);
  };

  if (error) {
    return (
      <section className="card span-12">
        <p className="formerror">Could not load the chart: {error}</p>
      </section>
    );
  }
  if (!chart) {
    return (
      <section className="card span-12">
        <p className="muted">Loading dental chart…</p>
      </section>
    );
  }

  const selectedSummary = selected
    ? chart.teeth.find((t) => t.tooth === selected)
    : undefined;
  const findings = selectedSummary?.conditions ?? [];

  return (
    <section className="card span-12">
      <header className="card__head">
        <h3><Activity size={16} aria-hidden /> Dental chart</h3>
        <div className="chartswitches">
          <div className="tabs tabs--sm">
            <button
              className={`tab${dentition === 'permanent' ? ' tab--active' : ''}`}
              onClick={() => { setDentition('permanent'); setSelected(null); }}
            >
              Adult
            </button>
            <button
              className={`tab${dentition === 'primary' ? ' tab--active' : ''}`}
              onClick={() => { setDentition('primary'); setSelected(null); }}
            >
              Pediatric
            </button>
          </div>
          <div className="tabs tabs--sm">
            <button
              className={`tab${notation === 'fdi' ? ' tab--active' : ''}`}
              onClick={() => setNotation('fdi')}
              title="FDI / ISO 3950 numbering"
            >
              FDI
            </button>
            <button
              className={`tab${notation === 'universal' ? ' tab--active' : ''}`}
              onClick={() => setNotation('universal')}
              title="Universal numbering (1–32 / A–T)"
            >
              Universal
            </button>
          </div>
        </div>
      </header>

      <div className="chartstats">
        <span className="cell-sub">{chart.summary.teethCharted} teeth charted</span>
        <span className="cell-sub">{chart.summary.active} active findings</span>
        {chart.summary.activeCaries > 0 && (
          <StatusPill status="severe" label={`${chart.summary.activeCaries} untreated caries`} />
        )}
      </div>

      <Odontogram
        dentition={dentition}
        notation={notation}
        teeth={chart.teeth}
        selected={selected}
        onSelectTooth={pickTooth}
        onSelectSurface={pickSurface}
      />

      <ConditionLegend />

      {selected === null ? (
        <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
          Select a tooth — or a single surface — to see and record findings.
        </p>
      ) : (
        <div className="toothpanel">
          <div className="toothpanel__head">
            <span className="recordrow__title">{toothLabel(selected, notation)}</span>
            {canEdit && !adding && (
              <button className="btn btn--ghost btn--sm" onClick={() => setAdding(true)}>
                <Plus size={14} /> Record finding
              </button>
            )}
          </div>

          {adding && (
            <FindingForm
              patientId={patientId}
              tooth={selected}
              initialSurface={preselectSurface}
              onDone={() => { setAdding(false); setPreselectSurface(null); load(); }}
              onCancel={() => { setAdding(false); setPreselectSurface(null); }}
            />
          )}

          {findings.length === 0 && !adding ? (
            <EmptyState
              icon={<Activity size={18} />}
              title="Nothing recorded on this tooth"
              body={canEdit ? 'Use “Record finding” to chart it.' : undefined}
            />
          ) : (
            <ul className="recordlist">
              {findings.map((f) => (
                <FindingRow key={f.id} finding={f} canEdit={canEdit} onChange={load} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The legend is grouped by family because the encoding is grouped by family.
 * A flat list of thirteen swatches asks the clinician to memorise thirteen
 * marks; four groups of three or four asks them to learn one rule per family
 * and then read the texture. Each swatch is the real thing — same colour,
 * same pattern, same outline, same glyph as the chart draws.
 */
function ConditionLegend() {
  const t = useT();
  const families = Object.keys(FAMILY_KEYS) as ConditionFamily[];
  return (
    <div className="legend">
      {families.map((family) => {
        const items = TOOTH_CONDITIONS.filter((c) => conditionStyle(c).family === family);
        if (items.length === 0) return null;
        return (
          <div className="legend__group" key={family}>
            <span className="legend__grouplabel">{t(FAMILY_KEYS[family])}</span>
            {items.map((c) => (
              <span key={c} className="legend__item">
                <ConditionSwatch condition={c} />
                {t(`tooth.condition.${c}`)}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function FindingRow({
  finding, canEdit, onChange,
}: {
  finding: ToothConditionRecord;
  canEdit: boolean;
  onChange: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not update the finding.');
      setBusy(false);
    }
  };

  return (
    <li className={`recordrow${finding.status !== 'active' ? ' recordrow--muted' : ''}`}>
      <div className="recordrow__main">
        <ConditionSwatch condition={finding.condition} size={16} />
        <span className="recordrow__title">{t(`tooth.condition.${finding.condition}`)}</span>
        <span className="cell-sub">
          {finding.surface
            ? surfaceName(finding.tooth, finding.surface)
            : 'Whole tooth'}
        </span>
        <StatusPill
          status={
            finding.status === 'active' ? 'severe'
              : finding.status === 'treated' ? 'current' : 'resolved'
          }
          label={
            finding.status === 'active' ? 'Active'
              : finding.status === 'treated' ? 'Treated' : 'Resolved'
          }
        />
        {finding.dentistName && <span className="cell-sub">{finding.dentistName}</span>}
        <span className="cell-sub">
          {new Date(finding.recordedAt).toLocaleDateString(dateLocale())}
        </span>
        {finding.note && <p className="muted recordrow__note">{finding.note}</p>}
        {err && <p className="formerror">{err}</p>}
      </div>
      {canEdit && (
        <div className="recordrow__actions">
          {finding.status === 'active' ? (
            <button
              className="iconbtn"
              disabled={busy}
              aria-label="Mark as treated"
              title="Mark as treated"
              onClick={() => act(() => chartApi.updateCondition(finding.id, { status: 'treated' }))}
            >
              <Check size={15} />
            </button>
          ) : (
            <button
              className="iconbtn"
              disabled={busy}
              aria-label="Reopen finding"
              title="Reopen"
              onClick={() => act(() => chartApi.updateCondition(finding.id, { status: 'active' }))}
            >
              <RotateCcw size={15} />
            </button>
          )}
          <button
            className="iconbtn"
            disabled={busy}
            aria-label="Delete finding"
            onClick={() => act(() => chartApi.deleteCondition(finding.id))}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </li>
  );
}

function FindingForm({
  patientId, tooth, initialSurface, onDone, onCancel,
}: {
  patientId: string;
  tooth: number;
  initialSurface: Surface | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [condition, setCondition] = useState<ToothCondition>('caries');
  const [surface, setSurface] = useState<Surface | ''>(initialSurface ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const wholeTooth = WHOLE_TOOTH_CONDITIONS.includes(condition);
  const available = surfacesFor(tooth);

  // Choosing a whole-tooth finding clears any surface: the API rejects the pair.
  useEffect(() => {
    if (wholeTooth && surface) setSurface('');
  }, [wholeTooth, surface]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await chartApi.addCondition(patientId, {
        tooth,
        surface: wholeTooth || !surface ? undefined : (surface as Surface),
        condition,
        note: note.trim() || undefined,
      });
      onDone();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not record the finding.');
      setBusy(false);
    }
  }

  return (
    <form className="inlineform" onSubmit={submit}>
      <div className="grid2">
        <label className="field"><span>Finding</span>
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value as ToothCondition)}
            autoFocus
          >
            {TOOTH_CONDITIONS.map((c) => (
              <option key={c} value={c}>{t(`tooth.condition.${c}`)}</option>
            ))}
          </select></label>
        <label className="field">
          <span>Surface{wholeTooth ? ' (whole tooth)' : ''}</span>
          <select
            value={surface}
            onChange={(e) => setSurface(e.target.value as Surface | '')}
            disabled={wholeTooth}
          >
            <option value="">Whole tooth</option>
            {available.map((s) => (
              <option key={s} value={s}>{surfaceName(tooth, s)}</option>
            ))}
          </select>
        </label>
      </div>
      {wholeTooth && (
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
          {t(`tooth.condition.${condition}`)} describes the whole tooth, so no surface applies.
        </p>
      )}
      <label className="field"><span>Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
      {err && <p className="formerror">{err}</p>}
      <div className="inlineform__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn--primary btn--sm" disabled={busy}>
          {busy ? 'Saving…' : 'Record finding'}
        </button>
      </div>
    </form>
  );
}
