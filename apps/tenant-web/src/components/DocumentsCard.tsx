import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  Download, FileText, Image as ImageIcon, Paperclip, Trash2, Upload, X,
} from 'lucide-react';
import {
  documentsApi,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  type DocumentKind,
  type PatientDocument,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, StatusPill } from './ui';

/**
 * Patient documents — X-rays, consent forms, referrals, insurance cards.
 *
 * Every download and preview goes through a short-lived signed URL fetched at
 * click time. No object URL is ever stored in component state longer than the
 * interaction, and nothing here is a public link.
 */

const ACCEPT = '.jpg,.jpeg,.png,.webp,.tif,.tiff,.pdf,.dcm,image/*,application/pdf';

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export default function DocumentsCard({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  const canUpload = can('documents:write');
  const canDelete = can('documents:delete');

  const [docs, setDocs] = useState<PatientDocument[] | null>(null);
  const [filter, setFilter] = useState<DocumentKind | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progressName, setProgressName] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ doc: PatientDocument; url: string } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const load = useCallback(() => {
    documentsApi
      .list(patientId)
      .then((d) => {
        setDocs(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [patientId]);

  useEffect(load, [load]);

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset immediately so picking the same file twice still fires onChange.
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    setProgressName(file.name);
    setError(null);
    setNotice(null);
    try {
      const res = await documentsApi.upload(patientId, file, { kind: 'other' });
      setNotice(
        res.duplicate
          ? `"${res.fileName}" is already attached to this patient — nothing was uploaded twice.`
          : `"${res.fileName}" uploaded.`,
      );
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      setProgressName(null);
    }
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
    setError(null);
    try {
      await documentsApi.remove(doc.id);
      setNotice(`"${doc.fileName}" removed.`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const changeKind = async (doc: PatientDocument, kind: DocumentKind) => {
    setError(null);
    try {
      await documentsApi.update(doc.id, { kind });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const visible = (docs ?? []).filter((d) => filter === 'all' || d.kind === filter);
  const kindsPresent = new Set((docs ?? []).map((d) => d.kind));

  return (
    <section className="card">
      <header className="card__head">
        <h3><Paperclip size={16} aria-hidden /> Documents &amp; X-rays</h3>
        {canUpload && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              onChange={onPick}
              style={{ display: 'none' }}
            />
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
            >
              <Upload size={14} aria-hidden />
              {uploading ? `Uploading ${progressName}…` : 'Upload'}
            </button>
          </>
        )}
      </header>

      {error && <p className="formerror">{error}</p>}
      {notice && <p className="muted" style={{ fontSize: 13 }}>{notice}</p>}

      {docs && docs.length > 0 && (
        <div className="tabs tabs--sm">
          <button
            className={`tab${filter === 'all' ? ' tab--active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All ({docs.length})
          </button>
          {DOCUMENT_KINDS.filter((k) => kindsPresent.has(k)).map((k) => (
            <button
              key={k}
              className={`tab${filter === k ? ' tab--active' : ''}`}
              onClick={() => setFilter(k)}
            >
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
                ? 'Upload an X-ray, consent form or referral. JPEG, PNG, WEBP, TIFF, PDF and DICOM are accepted.'
                : 'No documents have been attached to this patient.'
              : 'Try a different filter.'
          }
        />
      ) : (
        <ul className="doclist">
          {visible.map((doc) => (
            <li key={doc.id} className="doccard">
              <button
                className="doccard__thumb"
                onClick={() => openPreview(doc)}
                aria-label={`Preview ${doc.fileName}`}
              >
                {doc.isImage ? <ImageIcon size={22} /> : <FileText size={22} />}
              </button>

              <div className="doccard__body">
                <span className="doccard__name" title={doc.fileName}>{doc.fileName}</span>
                <div className="doccard__meta">
                  <StatusPill status="neutral" label={DOCUMENT_KIND_LABELS[doc.kind]} />
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
                    onChange={(e) => changeKind(doc, e.target.value as DocumentKind)}
                    aria-label={`Change type of ${doc.fileName}`}
                  >
                    {DOCUMENT_KINDS.map((k) => (
                      <option key={k} value={k}>{DOCUMENT_KIND_LABELS[k]}</option>
                    ))}
                  </select>
                )}
                <button
                  className="iconbtn"
                  onClick={() => download(doc)}
                  aria-label={`Download ${doc.fileName}`}
                >
                  <Download size={15} />
                </button>
                {canDelete && (
                  <button
                    className="iconbtn"
                    onClick={() => remove(doc)}
                    aria-label={`Delete ${doc.fileName}`}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {preview && (
        <div
          className="modal__overlay"
          role="dialog"
          aria-modal="true"
          aria-label={preview.doc.fileName}
          onClick={() => setPreview(null)}
        >
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <header className="modal__head">
              <h2>{preview.doc.fileName}</h2>
              <button className="iconbtn" onClick={() => setPreview(null)} aria-label="Close preview">
                <X size={16} />
              </button>
            </header>
            <div className="modal__body modal__body--media">
              {preview.doc.isImage ? (
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
          </div>
        </div>
      )}
    </section>
  );
}
