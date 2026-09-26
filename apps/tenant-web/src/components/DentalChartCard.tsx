import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  Ban,
  CalendarClock,
  Check,
  Clock,
  Hourglass,
  Plus,
  RotateCcw,
  ShieldCheck,
  StickyNote,
  X,
} from 'lucide-react';
import { WithdrawModal } from './VoidModal';
import {
  ApiError,
  chartApi,
  proceduresApi,
  TOOTH_CONDITIONS,
  WHOLE_TOOTH_CONDITIONS,
  type ClinicalProcedure,
  type DentalChart,
  type Surface,
  type ToothCondition,
  type ToothConditionRecord,
} from '../lib/api';
// Anatomy — the same module the API validates against.
import {
  archesFor,
  formatTooth,
  surfaceName,
  surfacesFor,
  toothLabel,
  type Dentition,
  type Notation,
} from '@dentalcare/shared';
// Drawing — this app's alone.
import {
  FAMILY_KEYS,
  anatomicalName,
  conditionStyle,
  type ConditionFamily,
} from '../lib/tooth-notation';
import { useAuth } from '../lib/auth';
import Odontogram, { ConditionSwatch } from './Odontogram';
import ArchView, { ArchLegend } from './ArchView';
import { dateLocale } from '../lib/strings';
import { t } from '../lib/strings';

type ChartMode = 'arch' | 'surfaces';
type RecState = 'pending' | 'done' | 'neutral' | 'planned' | 'progress';
interface StateMeta {
  state: RecState;
  label: string;
  icon: typeof Check;
}

/** A finding's place in its course of care. */
const FINDING_STATE: Record<ToothConditionRecord['status'], StateMeta> = {
  active: { state: 'pending', label: 'Needs treatment', icon: Hourglass },
  treated: { state: 'done', label: 'Treated', icon: Check },
  resolved: { state: 'neutral', label: 'Resolved', icon: Check },
};

/** A logged procedure's status, in the words a clinician uses. */
const PROC_STATE: Record<ClinicalProcedure['status'], StateMeta> = {
  completed: { state: 'done', label: 'Done', icon: Check },
  planned: { state: 'planned', label: 'Planned', icon: CalendarClock },
  in_progress: { state: 'progress', label: 'In progress', icon: Clock },
  cancelled: { state: 'neutral', label: 'Cancelled', icon: Ban },
};

type RecordItem =
  | {
      kind: 'finding';
      key: string;
      at: string;
      finding: ToothConditionRecord;
      treatment: ClinicalProcedure | null;
    }
  | { kind: 'procedure'; key: string; at: string; procedure: ClinicalProcedure };

/** A bare YYYY-MM-DD is read by parts, so it is not shifted by the UTC parse. */
function toDate(s: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
  }
  return new Date(s);
}

/**
 * The odontogram plus the record of the selected tooth.
 *
 * Notation, dentition and the Arch/Surfaces choice are view state, not data:
 * the chart is always stored in FDI, and a clinician switching views is
 * changing how they read it, not what was recorded.
 */
export default function DentalChartCard({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  const canEdit = can('clinical:write');
  const canSign = can('clinical:sign');

  const [chart, setChart] = useState<DentalChart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ChartMode>('arch');
  const [dentition, setDentition] = useState<Dentition>('permanent');
  const [notation, setNotation] = useState<Notation>('fdi');
  const [selected, setSelected] = useState<number | null>(null);
  const [preselectSurface, setPreselectSurface] = useState<Surface | null>(null);
  const [adding, setAdding] = useState(false);
  const [procedures, setProcedures] = useState<ClinicalProcedure[] | null>(null);

  const load = useCallback(() => {
    chartApi
      .get(patientId)
      .then((c) => {
        setChart(c);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
    // The treatment history beside the chart. Secondary to the chart itself:
    // if it cannot load, the tooth record says so and the chart still works.
    proceduresApi
      .list(patientId)
      .then(setProcedures)
      .catch(() => setProcedures([]));
  }, [patientId]);

  useEffect(load, [load]);

  const pickTooth = (tooth: number) => {
    setSelected(tooth);
    setPreselectSurface(null);
    setAdding(false);
  };
  const pickSurface = (tooth: number, s: Surface) => {
    setSelected(tooth);
    setPreselectSurface(s);
    if (canEdit) setAdding(true);
  };

  if (error) {
    return (
      <section className="card card--record span-12">
        <p className="formerror">Could not load the chart: {error}</p>
      </section>
    );
  }
  if (!chart) {
    return (
      <section className="card card--record span-12">
        <p className="muted">Loading dental chart…</p>
      </section>
    );
  }

  const selectedSummary = selected
    ? chart.teeth.find((x) => x.tooth === selected)
    : undefined;
  const findings = selectedSummary?.conditions ?? [];
  // Only teeth on the arch being shown: an adult finding offered as a quick
  // pick on the pediatric arch would select a tooth nobody can see.
  const { upper: upperArch, lower: lowerArch } = archesFor(dentition);
  const inView = new Set<number>([...upperArch, ...lowerArch]);
  const flagged = chart.teeth.filter(
    (x) => x.activeConditions.length > 0 && inView.has(x.tooth),
  );
  const toothProcedures = (procedures ?? []).filter((p) => p.tooth === selected);

  // One timeline per tooth. A finding shows the procedure that resolved it as
  // its treatment; a procedure that resolved nothing is its own entry.
  const byId = new Map((procedures ?? []).map((p) => [p.id, p]));
  const linked = new Set<string>();
  const records: RecordItem[] = findings.map((f) => {
    const treatment = f.resolvedByProcedureId ? (byId.get(f.resolvedByProcedureId) ?? null) : null;
    if (treatment) linked.add(treatment.id);
    return { kind: 'finding', key: f.id, at: f.recordedAt, finding: f, treatment };
  });
  for (const p of toothProcedures) {
    if (!linked.has(p.id)) {
      records.push({ kind: 'procedure', key: p.id, at: p.performedOn, procedure: p });
    }
  }
  records.sort((a, b) => toDate(b.at).getTime() - toDate(a.at).getTime());

  const segmented = <T extends string>(
    label: string,
    value: T,
    options: { key: T; label: string; title?: string }[],
    onChange: (v: T) => void,
  ) => (
    <div className="tabs tabs--sm" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`tab${value === o.key ? ' tab--active' : ''}`}
          aria-pressed={value === o.key}
          title={o.title}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <section className="card card--record span-12">
      <header className="card__head">
        <h3>
          <Activity size={16} aria-hidden /> Dental chart
        </h3>
        <div className="chartswitches">
          {segmented<ChartMode>(
            'Chart view',
            mode,
            [
              { key: 'arch', label: 'Arch', title: 'The whole mouth, tooth by tooth' },
              { key: 'surfaces', label: 'Surfaces', title: 'Chart findings surface by surface' },
            ],
            setMode,
          )}
          {segmented<Dentition>(
            'Dentition',
            dentition,
            [
              { key: 'permanent', label: 'Adult' },
              { key: 'primary', label: 'Pediatric' },
            ],
            (d) => {
              setDentition(d);
              setSelected(null);
            },
          )}
          {segmented<Notation>(
            'Numbering',
            notation,
            [
              { key: 'fdi', label: 'FDI', title: 'FDI / ISO 3950 numbering' },
              { key: 'universal', label: 'Universal', title: 'Universal numbering (1–32 / A–T)' },
            ],
            setNotation,
          )}
        </div>
      </header>

      <div className="chartstats">
        <span className="cell-sub">{chart.summary.teethCharted} teeth charted</span>
        <span className="cell-sub">{chart.summary.active} active findings</span>
        {chart.summary.activeCaries > 0 && (
          <span className="pill pill--danger">
            {chart.summary.activeCaries} untreated caries
          </span>
        )}
      </div>

      {/* The mouth on the left, the selected tooth's record on the right: the
          clinician keeps the whole arch in view while reading one tooth. */}
      <div className={`chartlayout${mode === 'arch' ? ' chartlayout--arch' : ''}`}>
        <div className="chartlayout__chart">
          {mode === 'arch' ? (
            <>
              <ArchView
                dentition={dentition}
                notation={notation}
                teeth={chart.teeth}
                selected={selected}
                onSelectTooth={pickTooth}
              />
              <ArchLegend />
            </>
          ) : (
            <>
              <Odontogram
                dentition={dentition}
                notation={notation}
                teeth={chart.teeth}
                selected={selected}
                onSelectTooth={pickTooth}
                onSelectSurface={pickSurface}
              />
              <ConditionLegend />
            </>
          )}
        </div>

        <aside className="toothhistory" aria-label="Selected tooth" aria-live="polite">
          {selected === null ? (
            <div className="toothhistory__empty">
              <h4 className="toothhistory__title">Select a tooth</h4>
              <p className="toothhistory__sub">
                Click a tooth on the chart to see its findings and treatment history
                {canEdit ? ', and to record a new finding' : ''}.
              </p>
              {flagged.length > 0 && (
                <>
                  <h5 className="toothhistory__section">Teeth with active findings</h5>
                  <div className="toothpicks">
                    {flagged.map((x) => (
                      <button
                        key={x.tooth}
                        type="button"
                        className="toothpick"
                        onClick={() => pickTooth(x.tooth)}
                      >
                        <span className="toothpick__num">
                          {formatTooth(x.tooth, notation)}
                        </span>
                        {x.activeConditions.map((c) => t(`tooth.condition.${c}`)).join(', ')}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="toothhistory__head">
                <span className="toothhistory__badge">{formatTooth(selected, notation)}</span>
                <div className="toothhistory__heading">
                  <h4 className="toothhistory__title">{anatomicalName(selected)}</h4>
                  <p className="toothhistory__sub">
                    {toothLabel(selected, notation)} · {findings.length} finding
                    {findings.length === 1 ? '' : 's'}
                    {procedures !== null &&
                      ` · ${toothProcedures.length} procedure${toothProcedures.length === 1 ? '' : 's'}`}
                  </p>
                </div>
                {canEdit && !adding && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setAdding(true)}
                  >
                    <Plus size={14} aria-hidden /> Record finding
                  </button>
                )}
              </div>

              {adding && (
                <FindingForm
                  patientId={patientId}
                  tooth={selected}
                  initialSurface={preselectSurface}
                  onDone={() => {
                    setAdding(false);
                    setPreselectSurface(null);
                    load();
                  }}
                  onCancel={() => {
                    setAdding(false);
                    setPreselectSurface(null);
                  }}
                />
              )}

              {records.length === 0 && !adding ? (
                <p className="toothhistory__none">
                  Nothing recorded on this tooth
                  {canEdit ? ' — use “Record finding” to chart it.' : '.'}
                </p>
              ) : (
                <ol className="rectimeline">
                  {records.map((r) =>
                    r.kind === 'finding' ? (
                      <FindingItem
                        key={r.key}
                        finding={r.finding}
                        treatment={r.treatment}
                        canEdit={canEdit}
                        canSign={canSign}
                        onChange={load}
                      />
                    ) : (
                      <ProcedureItem
                        key={r.key}
                        procedure={r.procedure}
                        tooth={selected}
                        canEdit={canEdit}
                        canSign={canSign}
                        onChange={load}
                      />
                    ),
                  )}
                </ol>
              )}
              {procedures === null && (
                <p className="toothhistory__none">Loading treatment history…</p>
              )}
            </>
          )}
        </aside>
      </div>
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

/* ── the tooth timeline ─────────────────────────────────── */

function DateBlock({ at }: { at: string }) {
  const d = toDate(at);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return (
    <time
      className="rec__date"
      dateTime={at}
      title={d.toLocaleDateString(dateLocale(), {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })}
    >
      <span className="rec__month">{d.toLocaleDateString(dateLocale(), { month: 'short' })}</span>
      <span className="rec__day">{d.getDate()}</span>
      {!sameYear && <span className="rec__year">{d.getFullYear()}</span>}
    </time>
  );
}

function StateBadge({ meta }: { meta: StateMeta }) {
  const Icon = meta.icon;
  return (
    <span className={`rec__status rec__status--${meta.state}`}>
      <Icon size={13} aria-hidden />
      {meta.label}
    </span>
  );
}

/**
 * Sign and withdraw for one logged procedure.
 *
 * Signing is final — the database refuses every later edit — so it is offered
 * only to someone who can sign, and only once the work is finished. A signed
 * procedure can still be withdrawn as entered in error, but only by someone
 * who could have signed it; the API enforces the same rule.
 */
function ProcedureActions({
  procedure: p,
  canEdit,
  canSign,
  onChange,
  label,
}: {
  procedure: ClinicalProcedure;
  canEdit: boolean;
  canSign: boolean;
  onChange: () => void;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const signed = Boolean(p.signedAt);
  const finished = p.status === 'completed' || p.status === 'cancelled';
  const mayWithdraw = canEdit && (!signed || canSign);
  if (!signed && !mayWithdraw && !(canSign && finished)) return null;

  const sign = async () => {
    setBusy(true);
    setErr(null);
    try {
      await proceduresApi.sign(p.id);
      onChange();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not sign the procedure.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {signed && (
        <p className="rec__note">
          <ShieldCheck size={13} aria-hidden />
          Signed{p.signedByName ? ` by ${p.signedByName}` : ''}
          {p.signedAt
            ? ` · ${new Date(p.signedAt).toLocaleDateString(dateLocale(), {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}`
            : ''}
        </p>
      )}
      {err && <p className="formerror">{err}</p>}
      <div className="rec__actions">
        {!signed && canSign && finished && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={sign}
            title="Sign this procedure. It cannot be edited afterwards."
          >
            <ShieldCheck size={14} aria-hidden /> Sign {label}
          </button>
        )}
        {mayWithdraw && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={() => setWithdrawing(true)}
            title="Withdraw as entered in error"
          >
            <X size={14} aria-hidden /> Withdraw {label}
          </button>
        )}
      </div>
      {withdrawing && (
        <WithdrawModal
          what={`the procedure “${p.description}”`}
          onClose={() => setWithdrawing(false)}
          onConfirm={async (reason) => {
            await proceduresApi.withdraw(p.id, reason);
            setWithdrawing(false);
            onChange();
          }}
        />
      )}
    </>
  );
}

function FindingItem({
  finding,
  treatment,
  canEdit,
  canSign,
  onChange,
}: {
  finding: ToothConditionRecord;
  treatment: ClinicalProcedure | null;
  canEdit: boolean;
  canSign: boolean;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const meta = FINDING_STATE[finding.status];

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
    <li className={`rec rec--${meta.state}`}>
      <DateBlock at={finding.recordedAt} />
      <div className="rec__card">
        <div className="rec__top">
          <dl className="rec__grid">
            <div>
              <dt>Condition</dt>
              <dd>
                <ConditionSwatch condition={finding.condition} size={14} />
                <span>
                  {t(`tooth.condition.${finding.condition}`)}
                  {finding.surface ? ` · ${surfaceName(finding.tooth, finding.surface)}` : ''}
                </span>
              </dd>
            </div>
            <div>
              <dt>Treatment</dt>
              <dd className={treatment ? undefined : 'muted'}>
                {treatment
                  ? treatment.description
                  : finding.status === 'active'
                    ? 'Not treated yet'
                    : 'Not logged'}
              </dd>
            </div>
            <div>
              <dt>Dentist</dt>
              <dd className={treatment?.clinicianName || finding.dentistName ? undefined : 'muted'}>
                {treatment?.clinicianName ?? finding.dentistName ?? '—'}
              </dd>
            </div>
          </dl>
          <StateBadge meta={meta} />
        </div>

        {finding.note && (
          <p className="rec__note">
            <StickyNote size={13} aria-hidden />
            {finding.note}
          </p>
        )}
        {err && <p className="formerror">{err}</p>}

        {canEdit && (
          <div className="rec__actions">
            {finding.status === 'active' ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={busy}
                onClick={() =>
                  act(() => chartApi.updateCondition(finding.id, { status: 'treated' }))
                }
              >
                <Check size={14} aria-hidden /> Mark treated
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={busy}
                onClick={() =>
                  act(() => chartApi.updateCondition(finding.id, { status: 'active' }))
                }
              >
                <RotateCcw size={14} aria-hidden /> Reopen
              </button>
            )}
            <button
              type="button"
              className="iconbtn iconbtn--quiet"
              disabled={busy}
              title="Withdraw as entered in error"
              aria-label={`Withdraw ${t(`tooth.condition.${finding.condition}`)} finding as entered in error`}
              onClick={() => setWithdrawing(true)}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {treatment && (
          <ProcedureActions
            procedure={treatment}
            canEdit={canEdit}
            canSign={canSign}
            onChange={onChange}
            label="treatment"
          />
        )}
      </div>
      {withdrawing && (
        <WithdrawModal
          what={`this ${t(`tooth.condition.${finding.condition}`).toLowerCase()} finding`}
          onClose={() => setWithdrawing(false)}
          onConfirm={async (reason) => {
            await chartApi.withdrawCondition(finding.id, reason);
            setWithdrawing(false);
            onChange();
          }}
        />
      )}
    </li>
  );
}

function ProcedureItem({
  procedure: p,
  tooth,
  canEdit,
  canSign,
  onChange,
}: {
  procedure: ClinicalProcedure;
  tooth: number;
  canEdit: boolean;
  canSign: boolean;
  onChange: () => void;
}) {
  const meta = PROC_STATE[p.status];
  return (
    <li className={`rec rec--${meta.state}`}>
      <DateBlock at={p.performedOn} />
      <div className="rec__card">
        <div className="rec__top">
          <dl className="rec__grid">
            <div>
              <dt>Condition</dt>
              <dd className={p.diagnosisCode ? undefined : 'muted'}>
                {p.diagnosisCode ?? 'No finding linked'}
              </dd>
            </div>
            <div>
              <dt>Treatment</dt>
              <dd>
                {p.description}
                {p.surfaces.length > 0 &&
                  ` · ${p.surfaces.map((s) => surfaceName(tooth, s)).join(', ')}`}
              </dd>
            </div>
            <div>
              <dt>Dentist</dt>
              <dd className={p.clinicianName ? undefined : 'muted'}>{p.clinicianName ?? '—'}</dd>
            </div>
          </dl>
          <StateBadge meta={meta} />
        </div>
        {p.note && (
          <p className="rec__note">
            <StickyNote size={13} aria-hidden />
            {p.note}
          </p>
        )}
        <ProcedureActions
          procedure={p}
          canEdit={canEdit}
          canSign={canSign}
          onChange={onChange}
          label="procedure"
        />
      </div>
    </li>
  );
}

function FindingForm({
  patientId,
  tooth,
  initialSurface,
  onDone,
  onCancel,
}: {
  patientId: string;
  tooth: number;
  initialSurface: Surface | null;
  onDone: () => void;
  onCancel: () => void;
}) {
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
        <label className="field">
          <span>Finding</span>
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value as ToothCondition)}
            autoFocus
          >
            {TOOTH_CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {t(`tooth.condition.${c}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Surface{wholeTooth ? ' (whole tooth)' : ''}</span>
          <select
            value={surface}
            onChange={(e) => setSurface(e.target.value as Surface | '')}
            disabled={wholeTooth}
          >
            <option value="">Whole tooth</option>
            {available.map((s) => (
              <option key={s} value={s}>
                {surfaceName(tooth, s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {wholeTooth && (
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
          {t(`tooth.condition.${condition}`)} describes the whole tooth, so no surface
          applies.
        </p>
      )}
      <label className="field">
        <span>Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </label>
      {err && <p className="formerror">{err}</p>}
      <div className="inlineform__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy}>
          {busy ? 'Saving…' : 'Record finding'}
        </button>
      </div>
    </form>
  );
}
