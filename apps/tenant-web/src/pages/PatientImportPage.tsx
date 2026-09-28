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
import { readXlsx } from '../lib/xlsx';
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
 * Bring a clinic's patients into DentalCare from Excel, CSV or another system.
 *
 * Upload, and DentalCare reads the file: when it recognises the name columns
 * it checks every row straight away and opens on what it found — how many
 * patients, how many are ready, which are already here, which need a look —
 * with Import as the one button. Matching the columns by hand is the step
 * for files it cannot read on its own ("Adjust columns").
 *
 * The review is produced by the API with the same rules the import applies,
 * and the import checks everything again, in batches that each land whole or
 * not at all.
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
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    balances: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Set when a new file's columns were recognised: it is checked at once,
  // and the columns step is only shown if the person asks for it.
  const autoReview = useRef(false);
  const [reading, setReading] = useState(false);

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

  // A recognised file is checked as soon as its columns are set.
  useEffect(() => {
    if (!autoReview.current || !parsed) return;
    autoReview.current = false;
    void runReview();
    // runReview reads the parsed file and mapping this effect waits for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <EmptyState
          framed
          icon={<Lock size={22} />}
          title="Administrator access only"
          body="Bulk import creates many records at once and can post opening balances, so it is restricted to administrators."
        />
      </div>
    );
  }

  async function readFile(file: File) {
    setError(null);
    let rows: string[][];
    if (/\.xlsx$/i.test(file.name)) {
      try {
        rows = await readXlsx(file);
      } catch {
        setError(
          'This Excel file could not be read. Open it in Excel, save it again as .xlsx, and try once more.',
        );
        return;
      }
    } else if (/\.(csv|txt)$/i.test(file.name)) {
      rows = parseCsv(await file.text()).rows;
    } else if (/\.xls$/i.test(file.name)) {
      setError(
        'This is the older Excel format (.xls). Open it in Excel and save it as .xlsx, then upload that.',
      );
      return;
    } else {
      setError('Choose an Excel (.xlsx) or CSV file.');
      return;
    }
    if (rows.length < 2) {
      setError('The file needs a header row and at least one patient.');
      return;
    }
    if (rows.length - 1 > MAX_ROWS) {
      setError(
        `The file has ${rows.length - 1} rows; up to ${MAX_ROWS.toLocaleString()} can be imported at once.`,
      );
      return;
    }
    const headers = rows[0]!.map((h) => h.trim());
    const guessed = guessMapping(headers);
    const names =
      (guessed.includes('firstName') && guessed.includes('lastName')) ||
      guessed.includes('fullName');
    autoReview.current = names;
    setReading(names);
    setParsed({ fileName: file.name, headers, rows: rows.slice(1) });
    setMapping(guessed);
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
  const missingNames = !(
    (mapped.has('firstName') && mapped.has('lastName')) ||
    mapped.has('fullName')
  );

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
        setProgress(
          `Checking rows ${batch.rowOffset + 1}–${batch.rowOffset + batch.rows.length} (${i + 1} of ${list.length})…`,
        );
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
      setReading(false);
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
        .reduce(
          (s, r) =>
            s +
            normalizeImportRow(records[r.row - 1] ?? {}, { dateFormat, countryCode })
              .value.balance,
          0,
        );
      setResult({ imported, skipped, balances });
      setStep('done');
    } catch (err) {
      setError(
        (err instanceof ApiError ? err.message : 'The import stopped.') +
          (imported > 0
            ? ` ${plural(imported, 'patient')} from earlier batches were imported; run the review again before continuing.`
            : ''),
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
  const phoneDuplicates =
    review?.filter(
      (r) => r.duplicateOf?.kind === 'patient' && r.duplicateOf.match === 'phone',
    ).length ?? 0;
  const alreadyHere =
    review?.filter((r) => r.duplicateOf?.kind === 'patient').length ?? 0;
  const repeated = counts.duplicate - alreadyHere;
  const willImport = counts.valid + (skipDuplicates ? 0 : phoneDuplicates);
  const visible = (review ?? [])
    .filter((r) => filter === 'all' || r.status === filter)
    .slice(0, 500);

  return (
    <div className="page">
      <PageHeader
        back={
          <Link to="/patients" className="back">
            <ChevronLeft size={16} aria-hidden /> All patients
          </Link>
        }
        title="Import patients"
        meta="From Excel, CSV or another practice system"
      />
      <ol className="import-steps" aria-label="Import steps">
        {(['upload', 'map', 'review', 'done'] as Step[]).map((s, i) => (
          <li key={s} aria-current={step === s ? 'step' : undefined}>
            {i + 1}.{' '}
            {{ upload: 'Upload', map: 'Columns', review: 'Review', done: 'Done' }[s]}
          </li>
        ))}
      </ol>

      {error && (
        <p className="formerror" role="alert">
          {error}
        </p>
      )}
      {progress && (
        <p className="muted" role="status">
          {progress}
        </p>
      )}

      {step === 'upload' && (
        <section className="card pad">
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.csv,text/csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void readFile(f);
            }}
          />
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
            <strong>Drop an Excel or CSV file here, or click to choose one</strong>
            <span>
              The first row should name the columns (Emri, Mbiemri, Telefoni…). DentalCare
              matches them for you.
            </span>
          </div>
        </section>
      )}

      {step === 'map' && parsed && reading && (
        <section className="card pad import-reading" role="status">
          <FileSpreadsheet size={22} aria-hidden />
          <div>
            <strong>Reading {parsed.fileName}</strong>
            <p className="muted">
              Checking {plural(parsed.rows.length, 'row')}: names, phone numbers, dates,
              and who is already in DentalCare.
            </p>
          </div>
        </section>
      )}

      {step === 'map' && parsed && !reading && (
        <section className="card">
          <div className="card__head">
            <div>
              <h2>{parsed.fileName}</h2>
              <p className="card__sub">
                {plural(parsed.rows.length, 'row')} · match each column to what it holds
              </p>
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
                  onChange={(field) =>
                    setMapping((m) =>
                      m.map((v, j) =>
                        j === i ? field : v === field && field ? null : v,
                      ),
                    )
                  }
                />
              ))}
            </div>
            <div className="grid2">
              <label className="field">
                <span>Dates in the file are written</span>
                <select
                  value={dateFormat}
                  onChange={(e) => setDateFormat(e.target.value as ImportDateFormat)}
                >
                  {IMPORT_DATE_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {DATE_FORMAT_LABEL[f]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Where the data came from</span>
                <input
                  value={sourceLabel}
                  onChange={(e) => setSourceLabel(e.target.value)}
                  placeholder="e.g. Excel, previous practice software"
                  maxLength={80}
                />
              </label>
            </div>
            <label className="hours-row__closed" style={{ width: 'auto' }}>
              <input
                type="checkbox"
                checked={skipDuplicates}
                onChange={(e) => setSkipDuplicates(e.target.checked)}
              />
              <span>Skip rows whose phone number matches an existing patient</span>
            </label>
            <span className="field-hint">
              A matching national ID is always skipped. Phone matches can be families
              sharing one number, so they can be imported deliberately.
            </span>
            {missingNames && (
              <p className="formerror">
                Say which column holds the names (first and last name, or one full-name
                column) to continue.
              </p>
            )}
            <div className="form__foot">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setStep('upload')}
              >
                Choose another file
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={missingNames || Boolean(progress)}
                onClick={runReview}
              >
                Check {plural(parsed.rows.length, 'row')}
              </button>
            </div>
          </div>
        </section>
      )}

      {step === 'review' && review && parsed && (
        <section className="card import-summary" aria-labelledby="import-found">
          <div className="import-summary__head">
            <FileSpreadsheet size={22} aria-hidden />
            <div>
              <h2 id="import-found">
                {plural(review.length, 'patient')} found in {parsed.fileName}
              </h2>
              <p className="card__sub">Nothing is saved until you press Import.</p>
            </div>
          </div>
          <dl className="sumstrip import-summary__counts">
            <div>
              <dt>Ready</dt>
              <dd>
                <strong>{counts.valid}</strong>
              </dd>
            </div>
            <div>
              <dt>Already in DentalCare</dt>
              <dd>
                <strong>{alreadyHere}</strong>
                {repeated > 0 && (
                  <span className="import-summary__sub">
                    +{repeated} repeated in the file
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>Need a look</dt>
              <dd>
                <strong className={counts.invalid ? 'sumstrip__due' : undefined}>
                  {counts.invalid}
                </strong>
              </dd>
            </div>
          </dl>
          {phoneDuplicates > 0 && (
            <label className="import-summary__opt">
              <input
                type="checkbox"
                checked={!skipDuplicates}
                onChange={(e) => setSkipDuplicates(!e.target.checked)}
              />
              <span>
                Also import the {plural(phoneDuplicates, 'patient')} whose phone matches
                someone already here. Families often share one number.
              </span>
            </label>
          )}
          <div className="import-summary__do">
            <button
              type="button"
              className="btn btn--primary"
              disabled={willImport === 0 || Boolean(progress)}
              onClick={runImport}
            >
              <Upload size={15} aria-hidden /> Import {plural(willImport, 'patient')}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setStep('map')}
            >
              Adjust columns
            </button>
          </div>
        </section>
      )}

      {step === 'review' && review && (
        <section className="card">
          <div className="card__head">
            <div>
              <h2>Check the list</h2>
              <p className="card__sub">
                Rows that need a look say why. Most are fixed with Adjust columns: the
                date format, or a column read as the wrong thing.
              </p>
            </div>
          </div>
          <div className="tabs tabs--sm" style={{ padding: '10px var(--gutter) 0' }}>
            {(['all', 'valid', 'invalid', 'duplicate'] as Filter[]).map((f) => (
              <button
                key={f}
                className={`tab${filter === f ? ' tab--active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {
                  {
                    all: `All (${review.length})`,
                    valid: `Ready (${counts.valid})`,
                    invalid: `Problems (${counts.invalid})`,
                    duplicate: `Duplicates (${counts.duplicate})`,
                  }[f]
                }
              </button>
            ))}
          </div>
          {/* It scrolls sideways on a phone: a keyboard reaches it too. */}
          <div
            className="import-table-wrap"
            role="region"
            aria-label="Rows in the file"
            tabIndex={0}
          >
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
                        status={
                          r.status === 'valid'
                            ? 'ok'
                            : r.status === 'invalid'
                              ? 'danger'
                              : 'warn'
                        }
                        label={
                          r.status === 'valid'
                            ? 'Ready'
                            : r.status === 'invalid'
                              ? 'Problem'
                              : 'Duplicate'
                        }
                      />
                    </td>
                    <td>
                      {r.errors.map((e, i) => (
                        <span className="row-issue" key={i}>
                          {IMPORT_FIELD_LABELS[e.field]}: {e.message}
                        </span>
                      ))}
                      {r.duplicateOf?.kind === 'file' && (
                        <span className="muted">
                          Repeats row {r.duplicateOf.row + 1} of the file
                        </span>
                      )}
                      {r.duplicateOf?.kind === 'patient' && (
                        <span className="muted">
                          Same{' '}
                          {r.duplicateOf.match === 'nationalId' ? 'national ID' : 'phone'}{' '}
                          as{' '}
                          <Link
                            className="link"
                            to={`/patients/${r.duplicateOf.patientId}`}
                            target="_blank"
                          >
                            {r.duplicateOf.name}
                          </Link>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form" style={{ paddingTop: 12 }}>
            {review.length > 500 && (
              <span className="field-hint">Showing the first 500 matching rows.</span>
            )}
            <div className="form__foot">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setStep('map')}
              >
                Adjust columns
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={willImport === 0 || Boolean(progress)}
                onClick={runImport}
              >
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
            action={
              <Link to="/patients" className="btn btn--primary btn--sm">
                Go to patients
              </Link>
            }
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
      <select
        value={value ?? ''}
        onChange={(e) => onChange((e.target.value || null) as ImportField | null)}
        aria-label={`Import ${header} as`}
      >
        <option value="">Don’t import</option>
        {IMPORT_FIELDS.map((f) => (
          <option key={f} value={f} disabled={taken.has(f) && value !== f}>
            {IMPORT_FIELD_LABELS[f]}
          </option>
        ))}
      </select>
      <span className="mapping-grid__sample" title={sample}>
        {sample || '—'}
      </span>
    </>
  );
}
