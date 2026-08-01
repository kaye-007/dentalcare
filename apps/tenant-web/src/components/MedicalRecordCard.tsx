import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import {
  appointmentsApi,
  medicalRecordApi,
  treatmentsApi,
  ApiError,
  type StaffMember,
  type ToothRecord,
  type Treatment,
} from '../lib/api';
import { StatusPill } from './ui';

/* ════════════════════════════════════════════════════════════
   Odontogram — SVG mouth with curved upper/lower arches (FDI).
   Teeth are positioned along two elliptical arcs facing each
   other, like a real dental chart.
   ════════════════════════════════════════════════════════════ */

/* FDI order, patient's right → left as the dentist views the chart */
const UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
const LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];

const W = 520;
const H = 470;

/* ── anatomical tooth glyphs (occlusal-ish outlines, crown pointing up) ──
   Four shapes matching real dental-chart iconography:
   incisor (narrow chisel), canine (pointed), premolar (two-cusp oval),
   molar (broad, multi-lobed). Each path is centred on (0,0). */
const TOOTH_PATHS: Record<ToothType, string> = {
  incisor:
    'M -7.5 13 Q -9.5 6 -8.5 -5 Q -8 -12.5 -3.5 -14 L 3.5 -14 Q 8 -12.5 8.5 -5 Q 9.5 6 7.5 13 Q 0 16.5 -7.5 13 Z',
  canine:
    'M -8.5 13 Q -10.5 3 -8 -6 Q -5 -14.5 0 -16 Q 5 -14.5 8 -6 Q 10.5 3 8.5 13 Q 0 17 -8.5 13 Z',
  premolar:
    'M -9.5 12.5 Q -12 3 -10 -6 Q -8 -13.5 -3 -13 Q 0 -10.5 3 -13 Q 8 -13.5 10 -6 Q 12 3 9.5 12.5 Q 0 16.5 -9.5 12.5 Z',
  molar:
    'M -12 12 Q -14.5 4 -13 -5 Q -12 -12 -7.5 -13.5 Q -4 -14.5 -2.5 -11.5 Q 0 -9 2.5 -11.5 Q 4 -14.5 7.5 -13.5 Q 12 -12 13 -5 Q 14.5 4 12 12 Q 6.5 16 0 15 Q -6.5 16 -12 12 Z',
};

type ToothType = 'incisor' | 'canine' | 'premolar' | 'molar';

/* FDI position within the quadrant: 1–2 incisors, 3 canine, 4–5 premolars, 6–8 molars */
function toothType(fdi: number): ToothType {
  const pos = fdi % 10;
  if (pos <= 2) return 'incisor';
  if (pos === 3) return 'canine';
  if (pos <= 5) return 'premolar';
  return 'molar';
}
const TYPE_SCALE: Record<ToothType, number> = {
  incisor: 0.86,
  canine: 0.92,
  premolar: 1.0,
  molar: 1.14,
};

interface ToothPos { x: number; y: number; angle: number; nx: number; ny: number }

function archPositions(opts: {
  cx: number; cy: number; rx: number; ry: number;
  fromDeg: number; toDeg: number; count: number;
}): ToothPos[] {
  const { cx, cy, rx, ry, fromDeg, toDeg, count } = opts;
  return Array.from({ length: count }, (_, i) => {
    const t = ((fromDeg + ((toDeg - fromDeg) * i) / (count - 1)) * Math.PI) / 180;
    const x = cx + rx * Math.cos(t);
    const y = cy + ry * Math.sin(t);
    const angle = (Math.atan2(ry * Math.sin(t), rx * Math.cos(t)) * 180) / Math.PI + 90;
    // outward unit direction (for number placement outside the arch)
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x, y, angle, nx: dx / len, ny: dy / len };
  });
}

/* Upper arch ∩ and lower arch ∪ facing each other, like a real chart. */
const UPPER_POS = archPositions({ cx: W / 2, cy: 222, rx: 212, ry: 188, fromDeg: 187, toDeg: 353, count: 16 });
const LOWER_POS = archPositions({ cx: W / 2, cy: 248, rx: 212, ry: 188, fromDeg: 173, toDeg: 7, count: 16 });

type ToothState = 'none' | 'pending' | 'done';

const FILL: Record<ToothState, string> = {
  none: 'var(--surface)',
  pending: 'var(--info-bg)',
  done: 'var(--ok-bg)',
};
const STROKE: Record<ToothState, string> = {
  none: '#b9c7c2',
  pending: '#7e9cd9',
  done: '#6fbd92',
};
const NUM: Record<ToothState, string> = {
  none: 'var(--muted-2)',
  pending: 'var(--info-fg)',
  done: 'var(--ok-fg)',
};

function OdontogramSvg({
  state,
  selected,
  onSelect,
}: {
  state: (tooth: number) => ToothState;
  selected: number | null;
  onSelect: (tooth: number) => void;
}) {
  const renderArch = (teeth: number[], pos: ToothPos[]) =>
    teeth.map((tooth, i) => {
      const p = pos[i]!;
      const s = state(tooth);
      const type = toothType(tooth);
      const scale = TYPE_SCALE[type];
      const isSel = selected === tooth;
      // numbers sit on the inner side of the horseshoe (classic chart layout,
      // and guaranteed collision-free at the arch apex and ends)
      const numX = p.x - p.nx * 27;
      const numY = p.y - p.ny * 27;
      return (
        <g key={tooth} className="odo-svg__tooth" onClick={() => onSelect(tooth)}>
          {/* tooth glyph, rotated to follow the arch */}
          <g transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${p.angle.toFixed(1)}) scale(${scale})`}>
            {isSel && (
              <path d={TOOTH_PATHS[type]} fill="none" stroke="var(--teal)"
                strokeWidth={5.5} opacity={0.25} />
            )}
            <path
              d={TOOTH_PATHS[type]}
              fill={FILL[s]}
              stroke={isSel ? 'var(--teal)' : STROKE[s]}
              strokeWidth={isSel ? 2.2 : 1.5}
              strokeLinejoin="round"
            />
            {/* subtle occlusal detail line for molars/premolars */}
            {(type === 'molar' || type === 'premolar') && (
              <path
                d={type === 'molar' ? 'M -6 1 Q 0 4.5 6 1' : 'M -4.5 0.5 Q 0 3.5 4.5 0.5'}
                fill="none"
                stroke={isSel ? 'var(--teal)' : STROKE[s]}
                strokeWidth={1.1}
                opacity={0.55}
              />
            )}
          </g>
          {/* FDI number outside the arch — horizontal, never rotated */}
          <text
            x={numX.toFixed(1)} y={numY.toFixed(1)}
            textAnchor="middle" dominantBaseline="central"
            fontSize={10.5} fontWeight={isSel ? 700 : 600}
            fill={isSel ? 'var(--teal-600)' : NUM[s]}
            style={{ pointerEvents: 'none', fontFamily: 'var(--font-body)' }}
          >
            {tooth}
          </text>
        </g>
      );
    });

  return (
    <svg className="odo-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Dental chart">
      <text x={W / 2} y={22} textAnchor="middle" fontSize={10} fontWeight={600}
        letterSpacing={1.6} fill="var(--muted-2)">UPPER</text>
      <text x={W / 2} y={H - 10} textAnchor="middle" fontSize={10} fontWeight={600}
        letterSpacing={1.6} fill="var(--muted-2)">LOWER</text>
      {/* midline + side markers, like a printed chart */}
      <line x1={W / 2} y1={36} x2={W / 2} y2={H - 26} stroke="var(--border)" strokeDasharray="3 5" />
      <line x1={26} y1={H / 2 + 1} x2={W - 26} y2={H / 2 + 1} stroke="var(--border)" strokeDasharray="3 5" />
      <text x={16} y={H / 2 + 4} fontSize={10} fontWeight={600} fill="var(--muted-2)">R</text>
      <text x={W - 22} y={H / 2 + 4} fontSize={10} fontWeight={600} fill="var(--muted-2)">L</text>
      {renderArch(UPPER, UPPER_POS)}
      {renderArch(LOWER, LOWER_POS)}
    </svg>
  );
}

/* ════════════════════════════════════════════════════════════ */

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const QUADRANT: Record<number, string> = { 1: 'Upper right', 2: 'Upper left', 3: 'Lower left', 4: 'Lower right' };
function toothLabel(t: number) {
  return `${QUADRANT[Math.floor(t / 10)]} · tooth ${t}`;
}

export default function MedicalRecordCard({ patientId }: { patientId: string }) {
  const [records, setRecords] = useState<ToothRecord[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [treatments, setTreatments] = useState<Treatment[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);

  async function load() {
    setRecords(await medicalRecordApi.list(patientId));
  }
  useEffect(() => {
    void load();
    treatmentsApi.list({ status: 'active' }).then(setTreatments).catch(() => setTreatments([]));
    appointmentsApi.staff()
      .then((list) => setStaff(list.filter((s) => s.status === 'active')))
      .catch(() => setStaff([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  useEffect(() => setAdding(false), [selected]);

  const byTooth = useMemo(() => {
    const m = new Map<number, ToothRecord[]>();
    (records ?? []).forEach((r) => m.set(r.tooth, [...(m.get(r.tooth) ?? []), r]));
    return m;
  }, [records]);

  const toothState = (t: number): ToothState => {
    const list = byTooth.get(t);
    if (!list?.length) return 'none';
    return list.some((r) => r.status === 'pending') ? 'pending' : 'done';
  };

  const recordedTeeth = useMemo(
    () => [...byTooth.keys()].sort((a, b) => a - b),
    [byTooth],
  );
  const selectedRecords = selected ? (byTooth.get(selected) ?? []) : [];

  return (
    <div className="card span-12">
      <div className="card__head">
        <div>
          <h2>Medical record</h2>
          <p className="card__sub">
            {records === null ? '…' : `${records.length} record(s) across ${recordedTeeth.length} teeth`}
          </p>
        </div>
        <div className="odo__legend">
          <span className="odo__key odo__key--pending" /> pending
          <span className="odo__key odo__key--done" /> treated
        </div>
      </div>

      <div className="odo">
        {/* the chart is the hero */}
        <div className="odo__chart">
          <OdontogramSvg state={toothState} selected={selected}
            onSelect={(t) => setSelected(selected === t ? null : t)} />
        </div>

        {/* contextual panel */}
        <div className="odo__panel">
          {selected === null ? (
            <div className="odo__overview">
              <p className="odo__overview-title">
                {recordedTeeth.length === 0
                  ? 'No teeth recorded yet'
                  : 'Teeth with records'}
              </p>
              {recordedTeeth.length === 0 ? (
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  Select a tooth on the chart to start this patient's dental history.
                </p>
              ) : (
                <div className="odo__chips">
                  {recordedTeeth.map((t) => (
                    <button key={t} className={`odo__chip odo__chip--${toothState(t)}`} onClick={() => setSelected(t)}>
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="odo__panel-head">
                <h3 className="odo__panel-title">{toothLabel(selected)}</h3>
                <button className="iconbtn" style={{ width: 28, height: 28 }}
                  onClick={() => setSelected(null)} title="Close">
                  <X size={14} />
                </button>
              </div>

              {selectedRecords.length === 0 ? (
                <p className="muted" style={{ fontSize: 13, margin: '2px 0 12px' }}>
                  No history for this tooth yet.
                </p>
              ) : (
                <ul className="odo__records">
                  {selectedRecords.map((r) => (
                    <li key={r.id} className="odo__record">
                      <span className="odo__record-dot" data-status={r.status} />
                      <div className="odo__record-main">
                        <span className="odo__record-cond">{r.condition}</span>
                        <span className="odo__record-meta">
                          {r.treatmentName ?? 'No treatment linked'}
                          {r.dentistName ? ` · ${r.dentistName}` : ''} · {fmtDate(r.recordedAt)}
                        </span>
                        {r.note && <span className="odo__record-note">{r.note}</span>}
                      </div>
                      <div className="odo__record-side">
                        <StatusPill status={r.status === 'done' ? 'completed' : 'scheduled'}
                          label={r.status === 'done' ? 'Done' : 'Pending'} />
                        {r.status === 'pending' && (
                          <button className="link"
                            onClick={async () => { await medicalRecordApi.update(r.id, { status: 'done' }); await load(); }}>
                            Mark done
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {adding ? (
                <AddRecordForm
                  patientId={patientId}
                  tooth={selected}
                  treatments={treatments}
                  staff={staff}
                  onCancel={() => setAdding(false)}
                  onSaved={async () => { setAdding(false); await load(); }}
                />
              ) : (
                <button className="btn btn--ghost btn--sm" onClick={() => setAdding(true)}>
                  <Plus size={14} /> Add record for tooth {selected}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AddRecordForm({
  patientId,
  tooth,
  treatments,
  staff,
  onCancel,
  onSaved,
}: {
  patientId: string;
  tooth: number;
  treatments: Treatment[];
  staff: StaffMember[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [condition, setCondition] = useState('');
  const [treatmentId, setTreatmentId] = useState('');
  const [dentistId, setDentistId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await medicalRecordApi.create(patientId, {
        tooth,
        condition: condition.trim(),
        treatmentId: treatmentId || undefined,
        dentistId: dentistId || undefined,
        note: note.trim() || undefined,
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save record.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="odo__form" onSubmit={submit}>
      <div className="grid2">
        <label className="field">
          <span>Condition</span>
          <input value={condition} onChange={(e) => setCondition(e.target.value)}
            placeholder="e.g. Caries" required minLength={2} autoFocus />
        </label>
        <label className="field">
          <span>Treatment</span>
          <select value={treatmentId} onChange={(e) => setTreatmentId(e.target.value)}>
            <option value="">—</option>
            {treatments.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      </div>
      <div className="grid2">
        <label className="field">
          <span>Dentist</span>
          <select value={dentistId} onChange={(e) => setDentistId(e.target.value)}>
            <option value="">—</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" maxLength={500} />
        </label>
      </div>
      {error && <p className="formerror">{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn--primary btn--sm" disabled={busy}>{busy ? 'Saving…' : 'Add record'}</button>
      </div>
    </form>
  );
}
