import { useCallback, useEffect, useState } from 'react';
import { Ruler, Plus, X, Droplet, ShieldCheck } from 'lucide-react';
import {
  ApiError,
  perioApi,
  PERIO_SITES,
  type PerioExam,
  type PerioExamSummary,
  type PerioSite,
  humanError,
} from '../lib/api';
import { archesFor, formatTooth } from '@dentalcare/shared';
import { useAuth } from '../lib/auth';
import { StatusPill, LoadingRows } from './ui';
import { WithdrawModal } from './VoidModal';
import { toDate } from '../lib/format';
import { dateLocale } from '../lib/strings';

/**
 * Periodontal charting.
 *
 * Readings are entered per tooth across six sites and saved as ONE request —
 * a full-mouth chart is 192 numbers, and 192 round trips would be slow and
 * could leave an exam half-recorded if the connection dropped.
 *
 * Edits are held locally until "Save readings" so a clinician can work down
 * the arch at probing speed without waiting for the network between numbers.
 *
 * A finished exam is signed. From then on the database refuses any change to
 * it or its readings, so the grid goes read-only. A wrong exam is withdrawn as
 * entered in error — never deleted.
 */

type Draft = Record<
  string,
  {
    probingDepth: number | null;
    recession: number | null;
    bleeding: boolean;
    suppuration: boolean;
  }
>;

const key = (tooth: number, site: PerioSite) => `${tooth}:${site}`;

/** 5 mm is the usual threshold at which a pocket becomes a concern. */
const DEEP = 5;

export default function PerioChartCard({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  const canEdit = can('clinical:write');
  const canSign = can('clinical:sign');

  const [exams, setExams] = useState<PerioExamSummary[] | null>(null);
  const [openExam, setOpenExam] = useState<PerioExam | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  const load = useCallback(() => {
    perioApi
      .listExams(patientId)
      .then((e) => {
        setExams(e);
        setError(null);
      })
      .catch((e) => setError(humanError(e)));
  }, [patientId]);

  useEffect(load, [load]);

  async function open(examId: string) {
    setError(null);
    try {
      const exam = await perioApi.getExam(examId);
      setOpenExam(exam);
      const d: Draft = {};
      for (const m of exam.measurements) {
        d[key(m.tooth, m.site)] = {
          probingDepth: m.probingDepth,
          recession: m.recession,
          bleeding: m.bleeding,
          suppuration: m.suppuration,
        };
      }
      setDraft(d);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not open the exam.');
    }
  }

  async function newExam() {
    setError(null);
    try {
      const exam = await perioApi.createExam(patientId);
      load();
      setOpenExam(exam);
      setDraft({});
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not start the exam.');
    }
  }

  /** The draft as the API wants it. Untouched sites are "not measured", not zero. */
  function draftMeasurements() {
    return Object.entries(draft)
      .filter(
        ([, v]) =>
          v.probingDepth !== null || v.recession !== null || v.bleeding || v.suppuration,
      )
      .map(([k, v]) => {
        const [tooth, site] = k.split(':');
        return {
          tooth: Number(tooth),
          site: site as PerioSite,
          probingDepth: v.probingDepth,
          recession: v.recession,
          bleeding: v.bleeding,
          suppuration: v.suppuration,
        };
      });
  }

  async function save() {
    if (!openExam) return;
    setBusy(true);
    setError(null);
    try {
      const measurements = draftMeasurements();
      if (measurements.length === 0) {
        setError('Enter at least one reading before saving.');
        return;
      }
      const updated = await perioApi.saveMeasurements(openExam.id, { measurements });
      setOpenExam(updated);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the readings.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Save whatever is on screen, then sign. Signing first would lock out the
   * readings the clinician just typed, and they would learn it only by
   * reopening the exam.
   */
  async function saveAndSign() {
    if (!openExam) return;
    setBusy(true);
    setError(null);
    try {
      const measurements = draftMeasurements();
      if (measurements.length > 0) {
        await perioApi.saveMeasurements(openExam.id, { measurements });
      }
      const signed = await perioApi.signExam(openExam.id);
      setOpenExam(signed);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not sign the exam.');
    } finally {
      setBusy(false);
    }
  }

  async function withdrawExam(id: string, reason: string) {
    await perioApi.withdrawExam(id, reason);
    setWithdrawing(null);
    if (openExam?.id === id) setOpenExam(null);
    load();
  }

  const EMPTY_CELL: Draft[string] = {
    probingDepth: null,
    recession: null,
    bleeding: false,
    suppuration: false,
  };

  const setCell = (tooth: number, site: PerioSite, patch: Partial<Draft[string]>) =>
    setDraft((d) => {
      const k = key(tooth, site);
      return { ...d, [k]: { ...EMPTY_CELL, ...d[k], ...patch } };
    });

  return (
    <section className="card card--record span-12">
      <header className="card__head">
        <h3>
          <Ruler size={16} aria-hidden /> Periodontal charting
        </h3>
        {canEdit && (
          <button className="btn btn--ghost btn--sm" onClick={newExam}>
            <Plus size={14} /> New exam
          </button>
        )}
      </header>

      {error && <p className="formerror">{error}</p>}

      {exams === null ? (
        <LoadingRows rows={3} label="Loading exams" />
      ) : exams.length === 0 ? (
        // One line, not an illustration: "none yet" is not news.
        <p className="medsec__none">
          No periodontal exams yet
          {canEdit
            ? ' — New exam records probing depths, recession, bleeding and mobility.'
            : '.'}
        </p>
      ) : (
        <ul className="recordlist">
          {exams.map((e) => (
            <li key={e.id} className="recordrow">
              <div className="recordrow__main">
                <button
                  type="button"
                  className="linkbtn recordrow__title"
                  onClick={() => (openExam?.id === e.id ? setOpenExam(null) : open(e.id))}
                >
                  {toDate(e.examinedOn).toLocaleDateString(dateLocale(), {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </button>
                <span className="cell-sub">{e.siteCount} sites</span>
                {e.siteCount > 0 && (
                  <StatusPill
                    status={
                      e.bleedingPercent >= 30
                        ? 'severe'
                        : e.bleedingPercent > 10
                          ? 'moderate'
                          : 'resolved'
                    }
                    label={`${e.bleedingPercent}% BOP`}
                  />
                )}
                {e.clinicianName && <span className="cell-sub">{e.clinicianName}</span>}
                {e.signedAt && (
                  <StatusPill
                    status="resolved"
                    label={`Signed${e.signedByName ? ` · ${e.signedByName}` : ''}`}
                  />
                )}
              </div>
              {canEdit && (!e.signedAt || canSign) && (
                <button
                  className="iconbtn"
                  onClick={() => setWithdrawing(e.id)}
                  aria-label="Withdraw exam as entered in error"
                  title="Withdraw as entered in error"
                >
                  <X size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {openExam && (
        <div className="periopanel">
          <div className="perio__summary">
            <Stat label="Sites recorded" value={String(openExam.summary.sitesRecorded)} />
            <Stat
              label="Bleeding on probing"
              value={`${openExam.summary.bleedingPercent}%`}
              alert={openExam.summary.bleedingPercent >= 30}
            />
            <Stat
              label={`Pockets ≥ ${DEEP} mm`}
              value={String(openExam.summary.deepPocketSites)}
              alert={openExam.summary.deepPocketSites > 0}
            />
            <Stat
              label="Max depth"
              value={
                openExam.summary.maxProbingDepth === null
                  ? '—'
                  : `${openExam.summary.maxProbingDepth} mm`
              }
            />
            <Stat
              label="Mean depth"
              value={
                openExam.summary.meanProbingDepth === null
                  ? '—'
                  : `${openExam.summary.meanProbingDepth} mm`
              }
            />
          </div>

          <div className="periogrid__wrap">
            <table className="periogrid">
              <thead>
                <tr>
                  <th>Tooth</th>
                  {PERIO_SITES.map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...archesFor('permanent').upper, ...archesFor('permanent').lower].map(
                  (tooth) => (
                    <tr key={tooth}>
                      <th scope="row">{formatTooth(tooth, 'fdi')}</th>
                      {PERIO_SITES.map((site) => {
                        const cell = draft[key(tooth, site)];
                        const depth = cell?.probingDepth ?? null;
                        return (
                          <td
                            key={site}
                            className={
                              depth !== null && depth >= DEEP
                                ? 'periocell--deep'
                                : undefined
                            }
                          >
                            <input
                              className="periocell__input"
                              inputMode="numeric"
                              maxLength={2}
                              value={depth === null ? '' : String(depth)}
                              disabled={!canEdit || Boolean(openExam.signedAt)}
                              aria-label={`Tooth ${tooth} ${site} probing depth`}
                              onChange={(ev) => {
                                const raw = ev.target.value.replace(/[^\d]/g, '');
                                const n = raw === '' ? null : Math.min(15, Number(raw));
                                setCell(tooth, site, { probingDepth: n });
                              }}
                            />
                            <button
                              type="button"
                              className={`periocell__bop${cell?.bleeding ? ' periocell__bop--on' : ''}`}
                              disabled={!canEdit || Boolean(openExam.signedAt)}
                              aria-label={`Tooth ${tooth} ${site} bleeding on probing`}
                              title="Bleeding on probing"
                              onClick={() =>
                                setCell(tooth, site, { bleeding: !cell?.bleeding })
                              }
                            >
                              <Droplet size={9} />
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>

          {openExam.signedAt ? (
            <div className="inlineform__foot">
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                <ShieldCheck size={13} aria-hidden /> Signed
                {openExam.signedByName ? ` by ${openExam.signedByName}` : ''} on{' '}
                {new Date(openExam.signedAt).toLocaleDateString(dateLocale(), {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
                . The readings can no longer change.
              </p>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => setOpenExam(null)}
              >
                Close
              </button>
            </div>
          ) : (
            canEdit && (
              <div className="inlineform__foot">
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => setOpenExam(null)}
                >
                  Close
                </button>
                {canSign && (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={saveAndSign}
                    disabled={busy}
                    title="Saves the readings on screen and signs the exam. A signed exam cannot change."
                  >
                    <ShieldCheck size={14} aria-hidden /> Save &amp; sign
                  </button>
                )}
                <button
                  className="btn btn--primary btn--sm"
                  onClick={save}
                  disabled={busy}
                >
                  {busy ? 'Saving…' : 'Save readings'}
                </button>
              </div>
            )
          )}
        </div>
      )}

      {withdrawing && (
        <WithdrawModal
          what="this periodontal exam"
          onClose={() => setWithdrawing(null)}
          onConfirm={(reason) => withdrawExam(withdrawing, reason)}
        />
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  alert,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div className={`periostat${alert ? ' periostat--alert' : ''}`}>
      <span className="periostat__value">{value}</span>
      <span className="periostat__label">{label}</span>
    </div>
  );
}
