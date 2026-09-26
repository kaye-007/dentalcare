import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, FileSpreadsheet, Lock, Upload } from 'lucide-react';
import {
  IMPORT_BATCH_LIMIT,
  IMPORT_DATE_FORMATS,
  IMPORT_FIELDS,
  IMPORT_FIELD_LABELS,
  duplicatesWithinFile,
  guessMapping,
  normalizeImportRow,
  parseCsv,
  type ImportDateFormat,
  type ImportField,
} from '@dentalcare/shared';
import {
  ApiError,
  patientImportApi,
  settingsApi,
  type ImportBatch,
  type ImportRowResult,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoney, plural } from '../lib/format';
import { EmptyState, PageHeader, StatusPill } from '../components/ui';

/** A spreadsheet with more rows than this is a data migration, not an upload. */
const MAX_ROWS = 20_000;

const DATE_FORMAT_LABEL: Record<ImportDateFormat, string> = {
  DMY: 'Day / month / year (31/12/1990)',
  MDY: 'Month / day / year (12/31/1990)',
  YMD: 'Year-month-day (1990-12-31)',
};

type Step = 'upload' | 'map' | 'review' | 'done';
type Filter = 'all' | 'valid' | 'invalid' | 'duplicate';

interface Parsed {
  fileName: string;
  headers: string[];
  rows: string[][];
}

/**
 * Bulk patient import from a CSV exported by a spreadsheet or a legacy system.
 *
 * Upload → map the columns → review what would happen → import. The review is
 * produced by the API with the same rules the import applies, and the import
 * checks everything again, in batches that each land whole or not at all.
 */
export default function PatientImportPage() {
  const { can } = useAuth();
  const [step, setStep] = useState<Step>('upload');
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<(ImportField | null)[]>([]);
  const [dateFormat, setDateFormat] = useState<ImportDateFormat>('DMY');
  const [sourceLabel, setSourceLabel] = useState('');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [countryCode, setCountryCode] = useState('355');
  const [review, setReview] = useState<ImportRowResult[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number; balances: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    settingsApi
      .get()
      .then((s) => setCountryCode(s.phoneCountryCode))
      .catch(() => undefined);
  }, []);

  /** Rows as the API expects them: keyed by field, mapped columns only. */
  const records = useMemo(() => {
    if (!parsed) return [];
    return parsed.rows.map((cells) => {
      const out: Record<string, string> = {};
      mapping.forEach((field, i) => {
        if (field) out[field] = cells[i] ?? '';
      });
      return out;
    });
  }, [parsed, mapping]);

  /** Repeats across the whole file, which the API only sees batch by batch. */
  const fileDuplicates = useMemo(
    () =>
      duplicatesWithinFile(
        records.map((r) => normalizeImportRow(r, { dateFormat, countryCode }).value),
      ),
    [records, dateFormat, countryCode],
  );

  if (!can('patients:import')) {
    return (
      <div className="page page--narrow">
        <PageHeader title="Import patients" />
        <EmptyState framed icon={<Lock size={22} />} title="Administrator access only" body="Bulk import creates many records at once and can post opening balances, so it is restricted to administrators." />
      </div>
    );
  }

  async function readFile(file: File) {
    setError(null);
    if (!/\.(csv|txt)$/i.test(file.name)) {
      setError('Save the spreadsheet as CSV first (File → Save as → CSV UTF-8), then upload that file.');
      return;
    }
    const { rows } = parseCsv(await file.text());
    if (rows.length < 2) {
      setError('The file needs a header row and at least one patient.');
      return;
    }
    if (rows.length - 1 > MAX_ROWS) {
      setError(`The file has ${rows.length - 1} rows; up to ${MAX_ROWS.toLocaleString()} can be imported at once.`);
      return;
    }
    const headers = rows[0]!.map((h) => h.trim());
    setParsed({ fileName: file.name, headers, rows: rows.slice(1) });
    setMapping(guessMapping(headers));
    setReview(null);
    setStep('map');
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void readFile(file);
  }

  const mapped = new Set(mapping.filter(Boolean));
  const missingNames = !mapped.has('firstName') || !mapped.has('lastName');

  function batches(): ImportBatch[] {
    const out: ImportBatch[] = [];
    for (let at = 0; at < records.length; at += IMPORT_BATCH_LIMIT) {
      out.push({
        fileName: parsed!.fileName,
        sourceLabel: sourceLabel.trim() || undefined,
        dateFormat,
        skipDuplicates,
        rowOffset: at,
        rows: records.slice(at, at + IMPORT_BATCH_LIMIT),
      });
    }
    return out;
  }

  async function runReview() {
    setError(null);
    setReview(null);
    const all: ImportRowResult[] = [];
    try {
      const list = batches();
      for (const [i, batch] of list.entries()) {
        setProgress(`Checking rows ${batch.rowOffset + 1}–${batch.rowOffset + batch.rows.length} (${i + 1} of ${list.length})…`);
        const res = await patientImportApi.preview(batch);
        all.push(...res.rows);
      }
      // A repeat of a row in an EARLIER batch is invisible to the API.
      for (const r of all) {
        const first = fileDuplicates.get(r.row - 1);
        if (first !== undefined && r.status === 'valid') {
          r.status = 'duplicate';
          r.duplicateOf = { kind: 'file', row: first + 1 };
        }
      }
      setReview(all);
      setStep('review');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The file could not be checked.');
    } finally {
      setProgress(null);
    }
  }

  async function runImport() {
    setError(null);
    let imported = 0;
    let skipped = 0;
    try {
      const list = batches();
      for (const [i, batch] of list.entries()) {
        setProgress(`Importing batch ${i + 1} of ${list.length}…`);
        // Rows that repeat an earlier batch are left out rather than sent to be
        // judged without the row they repeat.
        const rows = batch.rows.filter((_, j) => {
          const first = fileDuplicates.get(batch.rowOffset + j);
          return first === undefined || first >= batch.rowOffset;
        });
        skipped += batch.rows.length - rows.length;
        if (rows.length === 0) continue;
        const res = await patientImportApi.commit({ ...batch, rows });
        imported += res.imported;
        skipped += res.skipped;
      }
      const balances = (review ?? [])
        .filter((r) => r.status === 'valid')
        .reduce((s, r) => s + normalizeImportRow(records[r.row - 1] ?? {}, { dateFormat, countryCode }).value.balance, 0);
      setResult({ imported, skipped, balances });
      setStep('done');
    } catch (err) {
      setError(
        (err instanceof ApiError ? err.message : 'The import stopped.') +
          (imported > 0 ? ` ${plural(imported, 'patient')} from earlier batches were imported; run the review again before continuing.` : ''),
      );
    } finally {
      setProgress(null);
    }
  }

  const counts = {
    valid: review?.filter((r) => r.status === 'valid').length ?? 0,
    invalid: review?.filter((r) => r.status === 'invalid').length ?? 0,
    duplicate: review?.filter((r) => r.status === 'duplicate').length ?? 0,
  };
  const phoneDuplicates = review?.filter((r) => r.duplicateOf?.kind === 'patient' && r.duplicateOf.match === 'phone').length ?? 0;
  const willImport = counts.valid + (skipDuplicates ? 0 : phoneDuplicates);
  const visible = (review ?? []).filter((r) => filter === 'all' || r.status === filter).slice(0, 500);

  return (
    <div className="page">
      <PageHeader
        back={
          <Link to="/patients" className="back">
            <ChevronLeft size={16} aria-hidden /> All patients
          </Link>
        }
        title="Import patients"
        meta="From a spreadsheet or another practice system, as CSV"
      />
      <ol className="steps" aria-label="Import steps">
        {(['upload', 'map', 'review', 'done'] as Step[]).map((s, i) => (
          <li key={s} aria-current={step === s ? 'step' : undefined}>
            {i + 1}. {{ upload: 'Upload', map: 'Map columns', review: 'Review', done: 'Done' }[s]}
          </li>
        ))}
      </ol>

      {error && <p className="formerror" role="alert">{error}</p>}
      {progress && <p className="muted" role="status">{progress}</p>}

      {step === 'upload' && (
        <section className="card pad">
          <input ref={fileInput} type="file" accept=".csv,text/csv,.txt" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void readFile(f);
          }} />
          <div
            className={`dropzone${dragging ? ' dropzone--over' : ''}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && fileInput.current?.click()}
          >
            <FileSpreadsheet size={28} aria-hidden />
            <strong>Drop a CSV file here, or click to choose one</strong>
            <span>The first row must name the columns. Commas and semicolons are both understood.</span>
          </div>
        </section>
      )}

      {step === 'map' && parsed && (
        <section className="card">
          <div className="card__head">
            <div>
              <h2>{parsed.fileName}</h2>
              <p className="card__sub">{plural(parsed.rows.length, 'row')} · match each column to what it holds</p>
            </div>
          </div>
          <div className="form" style={{ paddingTop: 16 }}>
            <div className="mapping-grid">
              <strong className="muted">Column in the file</strong>
              <strong className="muted">Import as</strong>
              <strong className="muted">First value</strong>
              {parsed.headers.map((h, i) => (
                <FragmentRow
                  key={i}
                  header={h || `Column ${i + 1}`}
                  sample={parsed.rows.find((r) => r[i]?.trim())?.[i] ?? ''}
                  value={mapping[i] ?? null}
                  taken={mapped}
                  onChange={(field) => setMapping((m) => m.map((v, j) => (j === i ? field : v === field && field ? null : v)))}
                />
              ))}
            </div>
            <div className="grid2">
              <label className="field">
                <span>Dates in the file are written</span>
                <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as ImportDateFormat)}>
                  {IMPORT_DATE_FORMATS.map((f) => (
                    <option key={f} value={f}>{DATE_FORMAT_LABEL[f]}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Where the data came from</span>
                <input value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} placeholder="e.g. Excel, previous practice software" maxLength={80} />
              </label>
            </div>
            <label className="hours-row__closed" style={{ width: 'auto' }}>
              <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
              <span>Skip rows whose phone number matches an existing patient</span>
            </label>
            <span className="field-hint">
              A matching national ID is always skipped. Phone matches can be families sharing one number, so they
              can be imported deliberately.
            </span>
            {missingNames && <p className="formerror">Map both the first-name and last-name columns to continue.</p>}
            <div className="form__foot">
              <button type="button" className="btn btn--ghost" onClick={() => setStep('upload')}>Choose another file</button>
              <button type="button" className="btn btn--primary" disabled={missingNames || Boolean(progress)} onClick={runReview}>
                Check {plural(parsed.rows.length, 'row')}
              </button>
            </div>
          </div>
        </section>
      )}

      {step === 'review' && review && (
        <section className="card">
          <div className="card__head">
            <div>
              <h2>Review</h2>
              <p className="card__sub">
                {counts.valid} ready · {counts.invalid} with problems · {counts.duplicate} duplicates. Nothing has been
                saved yet.
              </p>
            </div>
          </div>
          <div className="tabs tabs--sm" style={{ padding: '10px var(--gutter) 0' }}>
            {(['all', 'valid', 'invalid', 'duplicate'] as Filter[]).map((f) => (
              <button key={f} className={`tab${filter === f ? ' tab--active' : ''}`} onClick={() => setFilter(f)}>
                {{ all: `All (${review.length})`, valid: `Ready (${counts.valid})`, invalid: `Problems (${counts.invalid})`, duplicate: `Duplicates (${counts.duplicate})` }[f]}
              </button>
            ))}
          </div>
          <div className="import-table-wrap">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>Row</th>
                  <th>Patient</th>
                  <th style={{ width: 110 }}>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.row}>
                    <td className="muted">{r.row + 1}</td>
                    <td>{r.name || <span className="muted">—</span>}</td>
                    <td>
                      <StatusPill
                        status={r.status === 'valid' ? 'ok' : r.status === 'invalid' ? 'danger' : 'warn'}
                        label={r.status === 'valid' ? 'Ready' : r.status === 'invalid' ? 'Problem' : 'Duplicate'}
                      />
                    </td>
                    <td>
                      {r.errors.map((e, i) => (
                        <span className="row-issue" key={i}>{IMPORT_FIELD_LABELS[e.field]}: {e.message}</span>
                      ))}
                      {r.duplicateOf?.kind === 'file' && <span className="muted">Repeats row {r.duplicateOf.row + 1} of the file</span>}
                      {r.duplicateOf?.kind === 'patient' && (
                        <span className="muted">
                          Same {r.duplicateOf.match === 'nationalId' ? 'national ID' : 'phone'} as{' '}
                          <Link className="link" to={`/patients/${r.duplicateOf.patientId}`} target="_blank">{r.duplicateOf.name}</Link>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form" style={{ paddingTop: 12 }}>
            {review.length > 500 && <span className="field-hint">Showing the first 500 matching rows.</span>}
            <div className="form__foot">
              <button type="button" className="btn btn--ghost" onClick={() => setStep('map')}>Back to mapping</button>
              <button type="button" className="btn btn--primary" disabled={willImport === 0 || Boolean(progress)} onClick={runImport}>
                <Upload size={15} aria-hidden /> Import {plural(willImport, 'patient')}
              </button>
            </div>
          </div>
        </section>
      )}

      {step === 'done' && result && (
        <section className="card pad">
          <EmptyState
            icon={<FileSpreadsheet size={22} />}
            title={`${plural(result.imported, 'patient')} imported`}
            body={`${plural(result.skipped, 'row')} skipped.${result.balances ? ` Opening balances of ${formatMoney(result.balances)} were posted to the patients' accounts.` : ''} The import is recorded in the activity trail.`}
            action={<Link to="/patients" className="btn btn--primary btn--sm">Go to patients</Link>}
          />
        </section>
      )}
    </div>
  );
}

function FragmentRow({
  header,
  sample,
  value,
  taken,
  onChange,
}: {
  header: string;
  sample: string;
  value: ImportField | null;
  taken: Set<ImportField | null>;
  onChange: (field: ImportField | null) => void;
}) {
  return (
    <>
      <span>{header}</span>
      <select value={value ?? ''} onChange={(e) => onChange((e.target.value || null) as ImportField | null)} aria-label={`Import ${header} as`}>
        <option value="">Don’t import</option>
        {IMPORT_FIELDS.map((f) => (
          <option key={f} value={f} disabled={taken.has(f) && value !== f}>
            {IMPORT_FIELD_LABELS[f]}
          </option>
        ))}
      </select>
      <span className="mapping-grid__sample" title={sample}>{sample || '—'}</span>
    </>
  );
}
