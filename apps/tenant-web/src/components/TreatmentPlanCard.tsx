import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ClipboardList, FileText, Plus, Trash2, X } from 'lucide-react';
import {
  ApiError,
  billingApi,
  procedureCodesApi,
  treatmentPlansApi,
  treatmentsApi,
  PLAN_STATUS_LABELS,
  type PlanItem,
  type PlanStatus,
  type ProcedureCode,
  type Surface,
  type Treatment,
  type TreatmentPlan,
} from '../lib/api';
import { formatMoney as money } from '../lib/format';
import { surfaceName, surfacesFor, toothLabel } from '../lib/tooth-notation';
import { useAuth } from '../lib/auth';
import { EmptyState, StatusPill } from './ui';

/**
 * Treatment plan builder.
 *
 * Every figure shown is computed by the API's cost engine and returned with
 * the plan — the browser never adds prices up itself. A quote the patient
 * sees on screen and a quote stored on the server that disagree by a unit is
 * the failure this avoids.
 */
export default function TreatmentPlanCard({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  const canEdit = can('clinical:write');

  const [plans, setPlans] = useState<TreatmentPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    treatmentPlansApi
      .listForPatient(patientId)
      .then((p) => { setPlans(p); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, [patientId]);

  useEffect(load, [load]);

  async function createPlan(title: string) {
    setError(null);
    try {
      const p = await treatmentPlansApi.create(patientId, { title });
      setCreating(false);
      setOpenId(p.id);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the plan.');
    }
  }

  return (
    <section className="card span-12">
      <header className="card__head">
        <h3><ClipboardList size={16} aria-hidden /> Treatment plans</h3>
        {canEdit && !creating && (
          <button className="btn btn--ghost btn--sm" onClick={() => setCreating(true)}>
            <Plus size={14} /> New plan
          </button>
        )}
      </header>

      {error && <p className="formerror">{error}</p>}

      {creating && (
        <NewPlanForm onCreate={createPlan} onCancel={() => setCreating(false)} />
      )}

      {plans === null ? (
        <p className="muted">Loading treatment plans…</p>
      ) : plans.length === 0 && !creating ? (
        <EmptyState
          icon={<ClipboardList size={20} />}
          title="No treatment plans"
          body={
            canEdit
              ? 'Build a plan from the chart findings, price it, and present it to the patient.'
              : 'No plans have been created for this patient.'
          }
        />
      ) : (
        <div className="planlist">
          {plans.map((p) => (
            <PlanBlock
              key={p.id}
              plan={p}
              open={openId === p.id}
              canEdit={canEdit}
              onToggle={() => setOpenId(openId === p.id ? null : p.id)}
              onChange={load}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function NewPlanForm({
  onCreate, onCancel,
}: { onCreate: (title: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  return (
    <form
      className="inlineform"
      onSubmit={(e) => { e.preventDefault(); if (title.trim()) onCreate(title.trim()); }}
    >
      <label className="field"><span>Plan title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Upper right quadrant restoration, Full mouth rehabilitation…"
          autoFocus
          required
          maxLength={150}
        /></label>
      <div className="inlineform__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn--primary btn--sm">Create plan</button>
      </div>
    </form>
  );
}

function PlanBlock({
  plan, open, canEdit, onToggle, onChange,
}: {
  plan: TreatmentPlan;
  open: boolean;
  canEdit: boolean;
  onToggle: () => void;
  onChange: () => void;
}) {
  const { can } = useAuth();
  const canBill = can('invoices:write');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [invoiceNotice, setInvoiceNotice] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not update the plan.');
    } finally {
      setBusy(false);
    }
  };

  const statusPill = (s: PlanStatus) =>
    s === 'accepted' || s === 'completed' ? 'current'
      : s === 'declined' ? 'severe'
        : s === 'in_progress' ? 'in_progress' : 'scheduled';

  return (
    <div className={`planblock${open ? ' planblock--open' : ''}`}>
      <button type="button" className="planblock__head" onClick={onToggle}>
        <span className="recordrow__title">{plan.title}</span>
        <StatusPill status={statusPill(plan.status)} label={PLAN_STATUS_LABELS[plan.status]} />
        <span className="cell-sub">
          {plan.cost.lineCount} procedure{plan.cost.lineCount === 1 ? '' : 's'}
        </span>
        <span className="planblock__total">{money(plan.cost.total)}</span>
      </button>

      {open && (
        <div className="planblock__body">
          {err && <p className="formerror">{err}</p>}
          {invoiceNotice && (
            <p className="muted" style={{ fontSize: 13 }}>{invoiceNotice}</p>
          )}

          {plan.items.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>
              No procedures yet. Add at least one before proposing this plan.
            </p>
          ) : (
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>Procedure</th><th>Tooth</th><th>Code</th>
                  <th className="num">Qty</th><th className="num">Fee</th>
                  <th className="num">Discount</th><th className="num">Total</th>
                  <th>Status</th>{canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {plan.items.map((i) => (
                  <PlanItemRow
                    key={i.id}
                    item={i}
                    canEdit={canEdit && plan.status !== 'completed'}
                    onChange={onChange}
                  />
                ))}
              </tbody>
            </table>
          )}

          {canEdit && plan.status !== 'completed' && (
            adding ? (
              <PlanItemForm
                planId={plan.id}
                onDone={() => { setAdding(false); onChange(); }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <button className="btn btn--ghost btn--sm" onClick={() => setAdding(true)}>
                <Plus size={14} /> Add procedure
              </button>
            )
          )}

          {/* The quote, exactly as the engine computed it. */}
          <div className="plantotals">
            <Row label="Subtotal" value={money(plan.cost.subtotal)} />
            {plan.cost.lineDiscounts > 0 && (
              <Row label="Line discounts" value={`− ${money(plan.cost.lineDiscounts)}`} />
            )}
            {plan.cost.planDiscount > 0 && (
              <Row label="Plan discount" value={`− ${money(plan.cost.planDiscount)}`} />
            )}
            <Row label="Patient total" value={money(plan.cost.total)} strong />
            {plan.cost.completedTotal > 0 && (
              <>
                <Row label="Completed so far" value={money(plan.cost.completedTotal)} />
                <Row label="Remaining" value={money(plan.cost.remainingTotal)} />
              </>
            )}
          </div>

          {plan.declineReason && (
            <p className="muted" style={{ fontSize: 12.5 }}>
              Declined: {plan.declineReason}
            </p>
          )}

          {canEdit && declining && (
            <div className="inlineform">
              <label className="field"><span>Why did the patient decline? (required)</span>
                <input
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                  placeholder="Cost, seeking a second opinion, postponed…"
                  autoFocus
                /></label>
              <div className="inlineform__foot">
                <button className="btn btn--ghost btn--sm" onClick={() => setDeclining(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn--danger-ghost btn--sm"
                  disabled={busy || !declineReason.trim()}
                  onClick={() =>
                    act(async () => {
                      await treatmentPlansApi.transition(plan.id, 'declined', declineReason.trim());
                      setDeclining(false);
                      setDeclineReason('');
                    })
                  }
                >
                  Record decline
                </button>
              </div>
            </div>
          )}

          {canEdit && !declining && plan.allowedTransitions.length > 0 && (
            <div className="apptactions">
              {plan.allowedTransitions.map((s) =>
                s === 'declined' ? (
                  <button
                    key={s}
                    className="btn btn--danger-ghost btn--sm"
                    onClick={() => setDeclining(true)}
                    disabled={busy}
                  >
                    Mark declined
                  </button>
                ) : (
                  <button
                    key={s}
                    className="btn btn--ghost btn--sm"
                    onClick={() => act(() => treatmentPlansApi.transition(plan.id, s))}
                    disabled={busy}
                  >
                    Mark {PLAN_STATUS_LABELS[s].toLowerCase()}
                  </button>
                ),
              )}
              {/* Billing is only offered once the patient has agreed the plan.
                  The API enforces the same rule — this just avoids showing a
                  button that would be refused. */}
              {canBill && ['accepted', 'in_progress', 'completed'].includes(plan.status) && (
                <button
                  className="btn btn--primary btn--sm"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      const inv = await billingApi.generateFromPlan(plan.id);
                      setInvoiceNotice(
                        `Invoice ${inv.invoiceNumber} created — ${money(inv.total)}` +
                        (inv.taxAmount > 0 ? ` (incl. ${money(inv.taxAmount)} VAT)` : ''),
                      );
                    })
                  }
                >
                  <FileText size={14} /> Invoice completed work
                </button>
              )}
              {['draft', 'proposed', 'declined'].includes(plan.status) && (
                <button
                  className="iconbtn"
                  disabled={busy}
                  aria-label="Delete plan"
                  onClick={() => act(() => treatmentPlansApi.remove(plan.id))}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`plantotals__row${strong ? ' plantotals__row--strong' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function PlanItemRow({
  item, canEdit, onChange,
}: { item: PlanItem; canEdit: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await treatmentPlansApi.removeItem(item.id);
      onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr className={item.status === 'cancelled' ? 'row--struck' : undefined}>
      <td>{item.description}</td>
      <td className="muted">
        {item.tooth ? toothLabel(item.tooth).replace(/^.*· /, '') : '—'}
        {item.surfaces.length > 0 && (
          <span className="cell-sub"> · {item.surfaces.join('')}</span>
        )}
      </td>
      <td className="muted">{item.code ?? '—'}</td>
      <td className="num">{item.quantity}</td>
      <td className="num">{money(item.unitFee)}</td>
      <td className="num">{item.discountAmount ? `− ${money(item.discountAmount)}` : '—'}</td>
      <td className="num" style={{ fontWeight: 600 }}>{money(item.total)}</td>
      <td>
        <StatusPill
          status={
            item.status === 'completed' ? 'current'
              : item.status === 'cancelled' ? 'resolved' : 'scheduled'
          }
          label={item.status[0]!.toUpperCase() + item.status.slice(1)}
        />
      </td>
      {canEdit && (
        <td>
          <button className="iconbtn" onClick={remove} disabled={busy} aria-label="Remove line">
            <X size={14} />
          </button>
        </td>
      )}
    </tr>
  );
}

function PlanItemForm({
  planId, onDone, onCancel,
}: { planId: string; onDone: () => void; onCancel: () => void }) {
  const [codes, setCodes] = useState<ProcedureCode[]>([]);
  const [treatments, setTreatments] = useState<Treatment[]>([]);
  const [description, setDescription] = useState('');
  const [codeId, setCodeId] = useState('');
  const [treatmentId, setTreatmentId] = useState('');
  const [tooth, setTooth] = useState('');
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [unitFee, setUnitFee] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    procedureCodesApi.list().then(setCodes).catch(() => setCodes([]));
    treatmentsApi.list({ status: 'active' }).then(setTreatments).catch(() => setTreatments([]));
  }, []);

  // Selecting from the catalogue fills the description and price, so a clinic
  // that maintains prices centrally does not retype them per plan.
  const pickCode = (id: string) => {
    setCodeId(id);
    const c = codes.find((x) => x.id === id);
    if (c) {
      if (!description.trim()) setDescription(c.description);
      if (c.defaultFee) setUnitFee(c.defaultFee);
    }
  };
  const pickTreatment = (id: string) => {
    setTreatmentId(id);
    const t = treatments.find((x) => x.id === id);
    if (t) {
      if (!description.trim()) setDescription(t.name);
      setUnitFee(t.price);
    }
  };

  const toothNum = Number(tooth);
  const availableSurfaces = tooth && !Number.isNaN(toothNum) ? surfacesFor(toothNum) : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await treatmentPlansApi.addItem(planId, {
        description: description.trim(),
        procedureCodeId: codeId || undefined,
        treatmentId: treatmentId || undefined,
        tooth: tooth ? toothNum : undefined,
        surfaces: surfaces.length ? surfaces : undefined,
        quantity,
        unitFee,
        discountAmount: discount || undefined,
      });
      onDone();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Could not add the procedure.');
      setBusy(false);
    }
  }

  return (
    <form className="inlineform" onSubmit={submit}>
      <div className="grid2">
        <label className="field"><span>From catalogue</span>
          <select value={treatmentId} onChange={(e) => pickTreatment(e.target.value)}>
            <option value="">Choose a treatment…</option>
            {treatments.map((t) => (
              <option key={t.id} value={t.id}>{t.name} — {money(t.price)}</option>
            ))}
          </select></label>
        <label className="field"><span>Code</span>
          <select value={codeId} onChange={(e) => pickCode(e.target.value)}>
            <option value="">No code</option>
            {codes.map((c) => (
              <option key={c.id} value={c.id}>{c.system} {c.code} — {c.description}</option>
            ))}
          </select></label>
      </div>

      <label className="field"><span>Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          maxLength={300}
          placeholder="Composite restoration"
        /></label>

      <div className="grid2">
        <label className="field"><span>Tooth (FDI, optional)</span>
          <input
            value={tooth}
            onChange={(e) => { setTooth(e.target.value); setSurfaces([]); }}
            placeholder="16"
            inputMode="numeric"
          /></label>
        <div className="field">
          <span>Surfaces</span>
          <div className="sendrow">
            {availableSurfaces.length === 0 ? (
              <span className="cell-sub">Enter a tooth first</span>
            ) : (
              availableSurfaces.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip${surfaces.includes(s) ? ' chip--on' : ''}`}
                  onClick={() =>
                    setSurfaces((cur) =>
                      cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s],
                    )
                  }
                  title={surfaceName(toothNum, s)}
                >
                  {s}
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="grid3">
        <label className="field"><span>Quantity</span>
          <input
            type="number" min={1} max={999} value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value) || 1)}
          /></label>
        <label className="field"><span>Fee each</span>
          <input
            type="number" min={0} value={unitFee}
            onChange={(e) => setUnitFee(Number(e.target.value) || 0)}
          /></label>
        <label className="field"><span>Discount</span>
          <input
            type="number" min={0} value={discount}
            onChange={(e) => setDiscount(Number(e.target.value) || 0)}
          /></label>
      </div>

      <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
        Line total: <strong>{money(Math.max(0, unitFee * quantity - discount))}</strong>
      </p>

      {err && <p className="formerror">{err}</p>}
      <div className="inlineform__foot">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn--primary btn--sm" disabled={busy}>
          {busy ? 'Adding…' : 'Add procedure'}
        </button>
      </div>
    </form>
  );
}
