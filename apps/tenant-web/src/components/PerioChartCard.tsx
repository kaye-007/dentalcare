import { useCallback, useEffect, useState } from 'react';
import { Ruler, Plus, Trash2, Droplet } from 'lucide-react';
import {
  ApiError,
  perioApi,
  PERIO_SITES,
  type PerioExam,
  type PerioExamSummary,
  type PerioSite,
} from '../lib/api';
import { archesFor, formatTooth } from '../lib/tooth-notation';
import { useAuth } from '../lib/auth';
import { EmptyState, StatusPill } from './ui';
import { dateLocale } from '../lib/i18n';

/**
 * Periodontal charting.
 *
 * Readings are entered per tooth across six sites and saved as ONE request —
 * a full-mouth chart is 192 numbers, and 192 round trips would be slow and
 * could leave an exam half-recorded if the connection dropped.
 *
 * Edits are held locally until "Save readings" so a clinician can work down
 * the arch at probing speed without waiting for the network between numbers.
 */

type Draft = Record<string, {
  probingDepth: number | null;
  recession: number | null;
  bleeding: boolean;
  suppuration: boolean;
}>;

const key = (tooth: number, site: PerioSite) => `${tooth}:${site}`;

/** 5 mm is the usual threshold at which a pocket becomes a concern. */
const DEEP = 5;

export default function PerioChartCard({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  const canEdit = can('clinical:write');

  const [exams, setExams] = useState<PerioExamSummary[] | null>(null);
  const [openExam, setOpenExam] = useState<PerioExam | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    perioApi
      .listExams(patientId)
      .then((e) => { setExams(e); setError(null); })
      .catch((e: Error) => setError(e.message));
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

  async function save() {
    if (!openExam) return;
    setBusy(true);
    setError(null);
    try {
      const measurements = Object.entries(draft)
        // Sites with nothing recorded are not sent: an untouched site is
        // "not measured", which is different from a measured zero.
        .filter(([, v]) =>
          v.probingDepth !== null || v.recession !== null || v.bleeding || v.suppuration)
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
      if (measurements.length === 0) {
        setError('Enter at least one reading before saving.');
        setBusy(false);
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

  async function removeExam(id: string) {
    setError(null);
    try {
      await perioApi.deleteExam(id);
      if (openExam?.id === id) setOpenExam(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete the exam.');
    }
  }

  const EMPTY_CELL: Draft[string] = {
    probingDepth: null, recession: null, bleeding: false, suppuration: false,
  };

  const setCell = (tooth: number, site: PerioSite, patch: Partial<Draft[string]>) =>
    setDraft((d) => {
      const k = key(tooth, site);
      return { ...d, [k]: { ...EMPTY_CELL, ...d[k], ...patch } };
    });

  return (
    <section className="card span-12">
      <header className="card__head">
        <h3><Ruler size={16} aria-hidden /> Periodontal charting</h3>
        {canEdit && (
          <button className="btn btn--ghost btn--sm" onClick={newExam}>
            <Plus size={14} /> New exam
          </button>
        )}
      </header>

      {error && <p className="formerror">{error}</p>}

      {exams === null ? (
        <p className="muted">Loading exams…</p>
      ) : exams.length === 0 ? (
        <EmptyState
          icon={<Ruler size={20} />}
          title="No periodontal exams"
          body={
            canEdit
              ? 'Start an exam to record probing depths, recession, bleeding and mobility.'
              : 'No periodontal exams have been recorded.'
          }
        />
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
                  {new Date(e.examinedOn).toLocaleDateString(dateLocale(), {
                    day: 'numeric', month: 'long', year: 'numeric',
                  })}
                </button>
                <span className="cell-sub">{e.siteCount} sites</span>
                {e.siteCount > 0 && (
                  <StatusPill
                    status={e.bleedingPercent >= 30 ? 'severe' : e.bleedingPercent > 10 ? 'moderate' : 'resolved'}
                    label={`${e.bleedingPercent}% BOP`}
                  />
                )}
                {e.clinicianName && <span className="cell-sub">{e.clinicianName}</span>}
              </div>
              {canEdit && (
                <button
                  className="iconbtn"
                  onClick={() => removeExam(e.id)}
                  aria-label="Delete exam"
                >
                  <Trash2 size={15} />
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
            <Stat label="Bleeding on probing" value={`${openExam.summary.bleedingPercent}%`}
              alert={openExam.summary.bleedingPercent >= 30} />
            <Stat label={`Pockets ≥ ${DEEP} mm`} value={String(openExam.summary.deepPocketSites)}
              alert={openExam.summary.deepPocketSites > 0} />
            <Stat label="Max depth"
              value={openExam.summary.maxProbingDepth === null ? '—' : `${openExam.summary.maxProbingDepth} mm`} />
            <Stat label="Mean depth"
              value={openExam.summary.meanProbingDepth === null ? '—' : `${openExam.summary.meanProbingDepth} mm`} />
          </div>

          <div className="periogrid__wrap">
            <table className="periogrid">
              <thead>
                <tr>
                  <th>Tooth</th>
                  {PERIO_SITES.map((s) => <th key={s}>{s}</th>)}
                </tr>
              </thead>
              <tbody>
                {[...archesFor('permanent').upper, ...archesFor('permanent').lower].map((tooth) => (
                  <tr key={tooth}>
                    <th scope="row">{formatTooth(tooth, 'fdi')}</th>
                    {PERIO_SITES.map((site) => {
                      const cell = draft[key(tooth, site)];
                      const depth = cell?.probingDepth ?? null;
                      return (
                        <td
                          key={site}
                          className={depth !== null && depth >= DEEP ? 'periocell--deep' : undefined}
                        >
                          <input
                            className="periocell__input"
                            inputMode="numeric"
                            maxLength={2}
                            value={depth === null ? '' : String(depth)}
                            disabled={!canEdit}
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
                            disabled={!canEdit}
                            aria-label={`Tooth ${tooth} ${site} bleeding on probing`}
                            title="Bleeding on probing"
                            onClick={() => setCell(tooth, site, { bleeding: !cell?.bleeding })}
                          >
                            <Droplet size={9} />
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canEdit && (
            <div className="inlineform__foot">
              <button className="btn btn--ghost btn--sm" onClick={() => setOpenExam(null)}>
                Close
              </button>
              <button className="btn btn--primary btn--sm" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : 'Save readings'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={`periostat${alert ? ' periostat--alert' : ''}`}>
      <span className="periostat__value">{value}</span>
      <span className="periostat__label">{label}</span>
    </div>
  );
}
