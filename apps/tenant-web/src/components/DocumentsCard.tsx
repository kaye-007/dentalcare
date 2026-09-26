import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  Camera, Columns2, Download, FileText, IdCard, Image as ImageIcon, Paperclip, Trash2, Upload,
} from 'lucide-react';
import {
  documentsApi,
  ApiError,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  PHOTO_TAGS,
  PHOTO_TAG_LABELS,
  type DocumentKind,
  type PatientDocument,
  type PhotoTag,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Modal, StatusPill } from './ui';
import CameraCaptureModal from './CameraCaptureModal';

/**
 * Patient documents — X-rays, clinical photos, consent forms, referrals.
 *
 * Every image and download goes through a short-lived signed URL. Thumbnails
 * are fetched as one batch of such links, so opening the tab is one entry in
 * the record-access log however many pictures it shows, and nothing here is
 * ever a public link.
 */

const ACCEPT = '.jpg,.jpeg,.png,.webp,.tif,.tiff,.pdf,.dcm,image/*,application/pdf';

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** What a picked file most likely is, before a person says otherwise. */
function guessKind(file: File): DocumentKind {
  if (/\.dcm$/i.test(file.name)) return 'xray';
  if (/pano|opg|rtg|x-?ray|bitewing|cbct/i.test(file.name)) return 'xray';
  if (/^image\//.test(file.type) && !/tiff/.test(file.type)) return 'photo';
  if (/consent|pelqim/i.test(file.name)) return 'consent';
  if (/passport|pasaport|id[-_ ]?card|karta|leternjoftim|letërnjoftim/i.test(file.name)) return 'id_document';
  return 'other';
}

export default function DocumentsCard({ patientId }: { patientId: string }) {
  const { can, readOnly } = useAuth();
  const canUpload = can('documents:write') && !readOnly;
  const canDelete = can('documents:delete') && !readOnly;

  const [docs, setDocs] = useState<PatientDocument[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<DocumentKind | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<{ files: File[]; defaults?: UploadDefaults } | null>(null);
  const [camera, setCamera] = useState<'clinical' | 'id' | null>(null);
  const [preview, setPreview] = useState<{ doc: PatientDocument; url: string } | null>(null);
  const [comparing, setComparing] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(() => {
    documentsApi
      .list(patientId)
      .then((d) => {
        setDocs(d);
        setError(null);
        if (d.some((x) => x.isPreviewable)) {
          documentsApi
            .thumbnails(patientId)
            .then((list) => setThumbs(Object.fromEntries(list.map((t) => [t.id, t.url]))))
            .catch(() => setThumbs({}));
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [patientId]);

  useEffect(load, [load]);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Reset immediately so picking the same file twice still fires onChange.
    e.target.value = '';
    if (files.length) setPending({ files: files.slice(0, 10) });
  };

  const openPreview = async (doc: PatientDocument) => {
    setError(null);
    try {
      const link = await documentsApi.viewUrl(doc.id);
      setPreview({ doc, url: link.url });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const download = async (doc: PatientDocument) => {
    setError(null);
    try {
      const link = await documentsApi.downloadUrl(doc.id);
      // The signed URL already carries Content-Disposition: attachment.
      window.open(link.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (doc: PatientDocument) => {
    if (!window.confirm(`Delete "${doc.fileName}"? The deletion is recorded in the activity trail.`)) return;
    setError(null);
    try {
      await documentsApi.remove(doc.id);
      setNotice(`"${doc.fileName}" removed.`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const change = async (doc: PatientDocument, patch: { kind?: DocumentKind; photoTag?: PhotoTag | null }) => {
    setError(null);
    try {
      await documentsApi.update(doc.id, patch);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const visible = (docs ?? []).filter((d) => filter === 'all' || d.kind === filter);
  const kindsPresent = new Set((docs ?? []).map((d) => d.kind));
  const tagged = useMemo(
    () => (docs ?? []).filter((d) => d.isPreviewable && (d.photoTag === 'before' || d.photoTag === 'after')),
    [docs],
  );
  const canCompare = tagged.some((d) => d.photoTag === 'before') && tagged.some((d) => d.photoTag === 'after');

  return (
    <section className="card card--record">
      <header className="card__head">
        <h3><Paperclip size={16} aria-hidden /> Documents, photos &amp; X-rays</h3>
        <div className="inline-row">
          {canCompare && (
            <button className="btn btn--ghost btn--sm" onClick={() => setComparing(true)}>
              <Columns2 size={14} aria-hidden /> Before / after
            </button>
          )}
          {canUpload && (
            <>
              <input ref={fileInput} type="file" accept={ACCEPT} multiple onChange={onPick} hidden />
              <button className="btn btn--ghost btn--sm" onClick={() => setCamera('clinical')}>
                <Camera size={14} aria-hidden /> Take photo
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setCamera('id')}>
                <IdCard size={14} aria-hidden /> Scan ID
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => fileInput.current?.click()}>
                <Upload size={14} aria-hidden /> Upload
              </button>
            </>
          )}
        </div>
      </header>

      {error && <p className="formerror">{error}</p>}
      {notice && <p className="muted" style={{ fontSize: 13 }}>{notice}</p>}

      {docs && docs.length > 0 && (
        <div className="tabs tabs--sm">
          <button className={`tab${filter === 'all' ? ' tab--active' : ''}`} onClick={() => setFilter('all')}>
            All ({docs.length})
          </button>
          {DOCUMENT_KINDS.filter((k) => kindsPresent.has(k)).map((k) => (
            <button key={k} className={`tab${filter === k ? ' tab--active' : ''}`} onClick={() => setFilter(k)}>
              {DOCUMENT_KIND_LABELS[k]} ({docs.filter((d) => d.kind === k).length})
            </button>
          ))}
        </div>
      )}

      {!docs ? (
        <p className="muted">Loading documents…</p>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Paperclip size={20} />}
          title={docs.length === 0 ? 'No documents yet' : 'Nothing of that type'}
          body={
            docs.length === 0
              ? canUpload
                ? 'Take a clinical photo, scan an ID, or upload an X-ray, a consent form or a referral. JPEG, PNG, WEBP, TIFF, PDF and DICOM are accepted.'
                : 'No documents have been attached to this patient.'
              : 'Try a different filter.'
          }
        />
      ) : (
        <ul className="doclist">
          {visible.map((doc) => (
            <li key={doc.id} className="doccard">
              <button className="doccard__thumb" onClick={() => openPreview(doc)} aria-label={`Preview ${doc.fileName}`}>
                {thumbs[doc.id] ? (
                  <img src={thumbs[doc.id]} alt="" loading="lazy" />
                ) : doc.isImage ? (
                  <ImageIcon size={22} />
                ) : (
                  <FileText size={22} />
                )}
              </button>

              <div className="doccard__body">
                <span className="doccard__name" title={doc.fileName}>{doc.fileName}</span>
                <div className="doccard__meta">
                  <StatusPill status="neutral" label={DOCUMENT_KIND_LABELS[doc.kind]} />
                  {doc.photoTag && <StatusPill status="info" label={PHOTO_TAG_LABELS[doc.photoTag]} />}
                  <span className="cell-sub">{formatBytes(doc.byteSize)}</span>
                  {doc.tooth && <span className="cell-sub">Tooth {doc.tooth}</span>}
                  {doc.takenOn && <span className="cell-sub">Taken {doc.takenOn}</span>}
                </div>
                {doc.caption && <p className="muted recordrow__note">{doc.caption}</p>}
                <span className="cell-sub">
                  {doc.uploadedByName ? `Uploaded by ${doc.uploadedByName}` : 'Uploaded'}
                  {' · '}
                  {new Date(doc.createdAt).toLocaleDateString()}
                </span>
              </div>

              <div className="doccard__actions">
                {canUpload && (
                  <select
                    className="select--bare"
                    value={doc.kind}
                    onChange={(e) => change(doc, { kind: e.target.value as DocumentKind })}
                    aria-label={`Change type of ${doc.fileName}`}
                  >
                    {DOCUMENT_KINDS.map((k) => (
                      <option key={k} value={k}>{DOCUMENT_KIND_LABELS[k]}</option>
                    ))}
                  </select>
                )}
                {canUpload && doc.kind === 'photo' && (
                  <select
                    className="select--bare"
                    value={doc.photoTag ?? ''}
                    onChange={(e) => change(doc, { photoTag: (e.target.value || null) as PhotoTag | null })}
                    aria-label={`Tag ${doc.fileName}`}
                  >
                    <option value="">No tag</option>
                    {PHOTO_TAGS.map((t) => (
                      <option key={t} value={t}>{PHOTO_TAG_LABELS[t]}</option>
                    ))}
                  </select>
                )}
                <button className="iconbtn" onClick={() => download(doc)} aria-label={`Download ${doc.fileName}`}>
                  <Download size={15} />
                </button>
                {canDelete && (
                  <button className="iconbtn" onClick={() => remove(doc)} aria-label={`Delete ${doc.fileName}`}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {camera && (
        <CameraCaptureModal
          title={camera === 'id' ? 'Scan an ID document' : 'Take a clinical photo'}
          subtitle={
            camera === 'id'
              ? 'Fit the card inside the outline, in good light and without glare.'
              : 'The picture is re-encoded before upload, so no location data leaves the device.'
          }
          frame={camera === 'id' ? 'card' : 'free'}
          onClose={() => setCamera(null)}
          onCapture={(file) => {
            setPending({
              files: [file],
              defaults: camera === 'id' ? { kind: 'id_document' } : { kind: 'photo', photoTag: 'progress' },
            });
            setCamera(null);
          }}
        />
      )}

      {pending && (
        <UploadModal
          patientId={patientId}
          files={pending.files}
          defaults={pending.defaults}
          onClose={() => setPending(null)}
          onDone={(message) => {
            setPending(null);
            setNotice(message);
            load();
          }}
        />
      )}

      {comparing && (
        <CompareModal photos={tagged} thumbs={thumbs} onClose={() => setComparing(false)} />
      )}

      {preview && (
        <Modal wide title={preview.doc.fileName} onClose={() => setPreview(null)}>
          <div className="modal__body modal__body--media">
            {preview.doc.isPreviewable ? (
              <img src={preview.url} alt={preview.doc.caption ?? preview.doc.fileName} />
            ) : preview.doc.contentType === 'application/pdf' ? (
              <iframe src={preview.url} title={preview.doc.fileName} />
            ) : (
              <EmptyState
                icon={<FileText size={20} />}
                title="No inline preview"
                body={`${preview.doc.contentType} cannot be shown in the browser. Download it to view.`}
                action={
                  <button className="btn btn--primary btn--sm" onClick={() => download(preview.doc)}>
                    <Download size={14} aria-hidden /> Download
                  </button>
                }
              />
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}

interface UploadDefaults {
  kind: DocumentKind;
  photoTag?: PhotoTag;
}

/**
 * Describe before sending. One set of details for every file picked at once:
 * a batch of photos from one appointment shares its date and its tag.
 */
function UploadModal({
  patientId,
  files,
  defaults,
  onClose,
  onDone,
}: {
  patientId: string;
  files: File[];
  /** What a camera capture was taken as; a picked file is guessed from its name. */
  defaults?: UploadDefaults;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [kind, setKind] = useState<DocumentKind>(defaults?.kind ?? guessKind(files[0]!));
  const [photoTag, setPhotoTag] = useState<PhotoTag | ''>(defaults?.photoTag ?? '');
  const [tooth, setTooth] = useState('');
  const [takenOn, setTakenOn] = useState(new Date().toLocaleDateString('en-CA'));
  const [caption, setCaption] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toothNumber = tooth.trim() ? Number(tooth) : undefined;
  const toothValid = toothNumber === undefined || (Number.isInteger(toothNumber) && toothNumber >= 11 && toothNumber <= 85);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!toothValid) return;
    setError(null);
    let uploaded = 0;
    let duplicates = 0;
    try {
      for (const [i, file] of files.entries()) {
        setProgress(`Uploading ${i + 1} of ${files.length}: ${file.name}`);
        const res = await documentsApi.upload(patientId, file, {
          kind,
          photoTag: kind === 'photo' && photoTag ? photoTag : undefined,
          tooth: toothNumber,
          takenOn: takenOn || undefined,
          caption: caption.trim() || undefined,
        });
        if (res.duplicate) duplicates++;
        else uploaded++;
      }
      onDone(
        `${uploaded} uploaded${duplicates ? `, ${duplicates} already attached and skipped` : ''}.`,
      );
    } catch (err) {
      setError(
        `${err instanceof ApiError ? err.message : 'The upload failed.'}${uploaded ? ` ${uploaded} file(s) before it were uploaded.` : ''}`,
      );
      setProgress(null);
    }
  }

  return (
    <Modal
      title={files.length === 1 ? `Upload ${files[0]!.name}` : `Upload ${files.length} files`}
      onClose={() => !progress && onClose()}
    >
      <form className="modal__body" onSubmit={submit}>
        <div className="grid2">
          <label className="field">
            <span>Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>{DOCUMENT_KIND_LABELS[k]}</option>
              ))}
            </select>
          </label>
          {kind === 'photo' ? (
            <label className="field">
              <span>Clinical stage</span>
              <select value={photoTag} onChange={(e) => setPhotoTag(e.target.value as PhotoTag | '')}>
                <option value="">Not tagged</option>
                {PHOTO_TAGS.map((t) => (
                  <option key={t} value={t}>{PHOTO_TAG_LABELS[t]}</option>
                ))}
              </select>
            </label>
          ) : (
            <span />
          )}
        </div>
        <div className="grid2">
          <label className="field">
            <span>Taken on</span>
            <input type="date" value={takenOn} onChange={(e) => setTakenOn(e.target.value)} />
          </label>
          <label className="field">
            <span>Tooth (FDI, optional)</span>
            <input inputMode="numeric" value={tooth} onChange={(e) => setTooth(e.target.value.replace(/\D/g, ''))} maxLength={2} placeholder="e.g. 36" />
            {!toothValid && <span className="row-issue">An FDI tooth number, 11–85</span>}
          </label>
        </div>
        <label className="field">
          <span>Caption</span>
          <input value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={300} placeholder="Optional" />
        </label>
        {progress && <p className="muted" role="status">{progress}</p>}
        {error && <p className="formerror">{error}</p>}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={Boolean(progress)}>Cancel</button>
            <button className="btn btn--primary" disabled={Boolean(progress) || !toothValid}>
              {progress ? 'Uploading…' : 'Upload'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** A before and an after photo side by side, each chosen from the tagged ones. */
function CompareModal({
  photos,
  thumbs,
  onClose,
}: {
  photos: PatientDocument[];
  thumbs: Record<string, string>;
  onClose: () => void;
}) {
  const befores = photos.filter((p) => p.photoTag === 'before');
  const afters = photos.filter((p) => p.photoTag === 'after');
  const [beforeId, setBeforeId] = useState(befores[0]?.id ?? '');
  const [afterId, setAfterId] = useState(afters[0]?.id ?? '');
  const [urls, setUrls] = useState<Record<string, string>>({});

  // Full-size views, fetched as needed; thumbnails show until they arrive.
  useEffect(() => {
    for (const id of [beforeId, afterId]) {
      if (!id || urls[id]) continue;
      documentsApi
        .viewUrl(id)
        .then((l) => setUrls((u) => ({ ...u, [id]: l.url })))
        .catch(() => undefined);
    }
  }, [beforeId, afterId, urls]);

  const describe = (p: PatientDocument) => `${p.takenOn ?? new Date(p.createdAt).toLocaleDateString()}${p.caption ? ` · ${p.caption}` : ''}`;
  const side = (label: string, list: PatientDocument[], id: string, set: (v: string) => void) => {
    const doc = list.find((p) => p.id === id);
    return (
      <figure>
        <select value={id} onChange={(e) => set(e.target.value)} aria-label={`${label} photo`} style={{ width: '100%', marginBottom: 8 }}>
          {list.map((p) => (
            <option key={p.id} value={p.id}>{`${label}: ${describe(p)}`}</option>
          ))}
        </select>
        {doc && <img src={urls[doc.id] ?? thumbs[doc.id]} alt={`${label}: ${doc.fileName}`} />}
        {doc && <figcaption>{describe(doc)}</figcaption>}
      </figure>
    );
  };

  return (
    <Modal wide title="Before and after" onClose={onClose}>
      <div className="modal__body">
        <div className="compare">
          {side('Before', befores, beforeId, setBeforeId)}
          {side('After', afters, afterId, setAfterId)}
        </div>
      </div>
    </Modal>
  );
}
