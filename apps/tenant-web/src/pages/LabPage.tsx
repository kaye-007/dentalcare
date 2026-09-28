import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlaskConical, Plus } from 'lucide-react';
import { humanError, labApi, settingsApi, type LabOrder } from '../lib/api';
import { useAuth } from '../lib/auth';
import { plural } from '../lib/format';
import LabOrderSheet from '../components/LabOrderSheet';
import PartnersModal from '../components/PartnersModal';
import { LabCancel, LabWorkRow, useLabMove } from '../components/LabWork';
import { EmptyState, ErrorState, LoadingRows, PageHeader } from '../components/ui';

/**
 * Lab work: every crown, bridge and appliance the clinic is waiting on.
 *
 * Read top to bottom it answers the desk's questions in order: what is late
 * or back and waiting to be fitted (needs someone), what is at the lab, what
 * is still being prepared. Each row has its one next step; calling or
 * messaging the lab, editing and cancelling are behind ⋯. Finished work is
 * one tap away, not in the way.
 */
export default function LabPage() {
  const { can, readOnly } = useAuth();
  const canWrite = can('lab:write') && !readOnly;
  const [open, setOpen] = useState<LabOrder[] | null>(null);
  const [done, setDone] = useState<LabOrder[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ order?: LabOrder } | null>(null);
  const [cancelling, setCancelling] = useState<LabOrder | null>(null);
  const [labs, setLabs] = useState(false);
  const [countryCode, setCountryCode] = useState('355');

  const load = useCallback(() => {
    labApi
      .list()
      .then((l) => {
        setOpen(l);
        setError(null);
      })
      .catch((err) => setError(humanError(err, 'Lab work could not be loaded.')));
    if (showDone) {
      labApi
        .list({ scope: 'done' })
        .then(setDone)
        .catch(() => setDone([]));
    }
  }, [showDone]);
  useEffect(load, [load]);
  useEffect(() => {
    settingsApi
      .get()
      .then((s) => setCountryCode(s.phoneCountryCode || '355'))
      .catch(() => undefined);
  }, []);

  const move = useLabMove(load);

  const groups = useMemo(() => {
    const all = open ?? [];
    return {
      attention: all
        .filter((o) => o.overdue || o.status === 'received')
        .sort((a, b) => Number(b.overdue) - Number(a.overdue)),
      atLab: all.filter((o) => o.status === 'sent' && !o.overdue),
      preparing: all.filter((o) => o.status === 'preparing' && !o.overdue),
    };
  }, [open]);

  const late = groups.attention.filter((o) => o.overdue).length;
  const back = groups.attention.length - late;
  const row = (o: LabOrder) => (
    <LabWorkRow
      key={o.id}
      order={o}
      canWrite={canWrite}
      countryCode={countryCode}
      onMove={(x, to) => void move(x, to)}
      onEdit={(x) => setSheet({ order: x })}
      onCancel={setCancelling}
    />
  );

  return (
    <div className="page">
      <PageHeader
        title="Lab work"
        meta={
          open === null
            ? 'Loading…'
            : open.length === 0
              ? 'Nothing at the lab'
              : [
                  late ? `${late} late` : null,
                  back ? `${back} back to fit` : null,
                  `${plural(open.filter((o) => o.status === 'sent').length, 'job')} at the lab`,
                ]
                  .filter(Boolean)
                  .join(' · ')
        }
        actions={
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setLabs(true)}
            >
              Labs
            </button>
            {canWrite && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setSheet({})}
              >
                <Plus size={16} aria-hidden /> Order lab work
              </button>
            )}
          </>
        }
      />

      {error ? (
        <div className="card">
          <ErrorState body={error} onRetry={load} />
        </div>
      ) : open === null ? (
        <div className="card">
          <LoadingRows rows={4} label="Loading lab work" />
        </div>
      ) : open.length === 0 ? (
        <EmptyState
          framed
          icon={<FlaskConical size={22} />}
          title="No lab work in progress"
          body="Crowns, bridges and appliances ordered from a lab appear here, with when they are due back."
          action={
            canWrite ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setSheet({})}
              >
                <Plus size={15} aria-hidden /> Order lab work
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="stack">
          {groups.attention.length > 0 && (
            <section className="card" aria-labelledby="lab-attention">
              <div className="card__head">
                <h2 id="lab-attention">Needs attention</h2>
                <p className="card__sub">
                  Late, or back from the lab and waiting to be fitted
                </p>
              </div>
              <ul className="labrows">{groups.attention.map(row)}</ul>
            </section>
          )}
          {groups.atLab.length > 0 && (
            <section className="card" aria-labelledby="lab-at">
              <div className="card__head">
                <h2 id="lab-at">At the lab</h2>
              </div>
              <ul className="labrows">{groups.atLab.map(row)}</ul>
            </section>
          )}
          {groups.preparing.length > 0 && (
            <section className="card" aria-labelledby="lab-prep">
              <div className="card__head">
                <h2 id="lab-prep">Preparing</h2>
                <p className="card__sub">Ordered, not sent yet</p>
              </div>
              <ul className="labrows">{groups.preparing.map(row)}</ul>
            </section>
          )}
        </div>
      )}

      <div className="lab__done">
        <button
          type="button"
          className="btn btn--quiet btn--sm"
          aria-expanded={showDone}
          onClick={() => setShowDone((v) => !v)}
        >
          {showDone ? 'Hide finished lab work' : 'Show fitted and cancelled'}
        </button>
        {showDone && (
          <section className="card" aria-label="Finished lab work">
            {done === null ? (
              <LoadingRows rows={3} label="Loading finished lab work" />
            ) : done.length === 0 ? (
              <p className="dash__calm">Nothing finished yet.</p>
            ) : (
              <ul className="labrows">{done.map(row)}</ul>
            )}
          </section>
        )}
      </div>

      {sheet && (
        <LabOrderSheet
          order={sheet.order}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null);
            load();
          }}
        />
      )}
      {cancelling && (
        <LabCancel
          order={cancelling}
          onClose={() => setCancelling(null)}
          onCancel={(reason) => {
            const o = cancelling;
            setCancelling(null);
            void move(o, 'cancelled', reason);
          }}
        />
      )}
      {labs && (
        <PartnersModal kind="lab" canWrite={canWrite} onClose={() => setLabs(false)} />
      )}
    </div>
  );
}
