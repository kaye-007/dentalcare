import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  humanError,
  labApi,
  labsApi,
  treatmentsApi,
  type LabOrder,
  type Partner,
  type StaffMember,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { loadPractitioners } from '../lib/practitioners';
import MoneyInput from './MoneyInput';
import PatientPicker from './PatientPicker';
import { Disclosure, Modal, useToast } from './ui';

/** Every FDI tooth number, permanent and deciduous. */
const FDI = new Set([
  ...[1, 2, 3, 4].flatMap((q) => [1, 2, 3, 4, 5, 6, 7, 8].map((t) => q * 10 + t)),
  ...[5, 6, 7, 8].flatMap((q) => [1, 2, 3, 4, 5].map((t) => q * 10 + t)),
]);

/** "36", "34, 35 36" or "34-36" → [34, 35, 36]; an error in words otherwise. */
function parseTeeth(raw: string): { teeth: number[]; error: string | null } {
  const out: number[] = [];
  for (const part of raw.split(/[\s,;]+/).filter(Boolean)) {
    const range = /^(\d{2})\s*[-–]\s*(\d{2})$/.exec(part);
    const nums = range
      ? Array.from(
          { length: Math.abs(Number(range[2]) - Number(range[1])) + 1 },
          (_, i) => Math.min(Number(range[1]), Number(range[2])) + i,
        )
      : [Number(part)];
    for (const n of nums) {
      if (!Number.isInteger(n) || !FDI.has(n)) {
        return {
          teeth: [],
          error: `${range ? part : n} is not a tooth number (FDI, e.g. 36).`,
        };
      }
      out.push(n);
    }
  }
  return { teeth: [...new Set(out)].sort((a, b) => a - b), error: null };
}

const pad = (n: number) => String(n).padStart(2, '0');
function inDays(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Order lab work, or change it.
 *
 * The first screen is what the lab needs to know: whose, what, which teeth,
 * which lab, by when. Who ordered it defaults to the person ordering, when
 * they treat patients; material, shade, the lab's price and notes are under
 * Details. What the clinic calls its work comes from its own price list, so
 * "Kurorë zirkoni" is typed once, in the catalogue.
 */
export default function LabOrderSheet({
  order,
  patient,
  onClose,
  onSaved,
}: {
  /** Editing this order. */
  order?: LabOrder;
  /** Ordering for this patient: they are not asked for. */
  patient?: { id: string; name: string };
  onClose: () => void;
  onSaved: (o: LabOrder) => void;
}) {
  const { user, can } = useAuth();
  const toast = useToast();
  const editing = Boolean(order);
  const [patientId, setPatientId] = useState(order?.patientId ?? patient?.id ?? '');
  const [patientName, setPatientName] = useState(
    order?.patientName ?? patient?.name ?? '',
  );
  const [work, setWork] = useState(order?.work ?? '');
  const [teeth, setTeeth] = useState(order ? order.teeth.join(', ') : '');
  const [labId, setLabId] = useState(order?.labId ?? '');
  const [dueOn, setDueOn] = useState(order ? (order.dueOn ?? '') : inDays(7));
  const [dentistId, setDentistId] = useState(order?.dentistId ?? '');
  const [material, setMaterial] = useState(order?.material ?? '');
  const [shade, setShade] = useState(order?.shade ?? '');
  const [cost, setCost] = useState<number | null>(order?.cost ?? null);
  const [notes, setNotes] = useState(order?.notes ?? '');
  const [labs, setLabs] = useState<Partner[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [works, setWorks] = useState<string[]>([]);
  const [addingLab, setAddingLab] = useState(false);
  const [labName, setLabName] = useState('');
  const [labPhone, setLabPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    labsApi
      .list()
      .then((l) => {
        setLabs(l);
        // One lab is the lab.
        if (!order && l.length === 1) setLabId((cur) => cur || l[0]!.id);
      })
      .catch(() => setLabs([]));
    loadPractitioners()
      .then((list) => {
        setStaff(list);
        // Whoever orders it, when they treat patients, is who it is for.
        if (!order && user && list.some((s) => s.id === user.id)) {
          setDentistId((cur) => cur || user.id);
        }
      })
      .catch(() => setStaff([]));
    if (can('treatments:read')) {
      treatmentsApi
        .list({ status: 'active' })
        .then((t) => setWorks(t.map((x) => x.name)))
        .catch(() => setWorks([]));
    }
  }, [order, user, can]);

  const parsed = useMemo(() => parseTeeth(teeth), [teeth]);

  async function addLab() {
    if (labName.trim().length < 2) return;
    try {
      const lab = await labsApi.create({
        name: labName.trim(),
        phone: labPhone.trim() || undefined,
      });
      setLabs((l) => [...l, lab].sort((a, b) => a.name.localeCompare(b.name)));
      setLabId(lab.id);
      setAddingLab(false);
      setLabName('');
      setLabPhone('');
    } catch (err) {
      setError(humanError(err, 'The lab could not be added.'));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!patientId) return setError('Choose the patient.');
    if (work.trim().length < 2) return setError('Say what the lab is making.');
    if (parsed.error) return setError(parsed.error);
    setError(null);
    setBusy(true);
    const fields = {
      work: work.trim(),
      teeth: parsed.teeth,
      labId: labId || null,
      dentistId: dentistId || null,
      material: material.trim() || null,
      shade: shade.trim() || null,
      cost,
      dueOn: dueOn || null,
      notes: notes.trim() || null,
    };
    try {
      const saved = order
        ? await labApi.update(order.id, fields)
        : await labApi.create({ patientId, ...fields });
      toast(
        order
          ? `Saved ${saved.work} for ${saved.patientName}.`
          : `Lab work ordered: ${saved.work} for ${saved.patientName}.`,
      );
      onSaved(saved);
    } catch (err) {
      setError(humanError(err, 'The lab work could not be saved. Try again.'));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editing ? 'Lab work' : 'Order lab work'}
      subtitle={
        editing ? patientName : 'Whose, what, and by when. The rest is under Details.'
      }
      onClose={onClose}
    >
      <form className="modal__body labsheet" onSubmit={submit}>
        {!editing && !patient && (
          <PatientPicker
            canCreate={false}
            value={patientName}
            onPick={(p) => {
              setPatientId(p.id);
              setPatientName(`${p.firstName} ${p.lastName}`);
            }}
            onClear={() => {
              setPatientId('');
              setPatientName('');
            }}
          />
        )}
        <label className="field">
          <span>What the lab is making</span>
          <input
            value={work}
            onChange={(e) => setWork(e.target.value)}
            list="lab-work-names"
            placeholder="e.g. Kurorë zirkoni"
            maxLength={200}
            autoFocus={Boolean(patient) || editing}
          />
          <datalist id="lab-work-names">
            {works.map((w) => (
              <option key={w} value={w} />
            ))}
          </datalist>
        </label>
        <div className="grid2">
          <label className="field">
            <span>Teeth (FDI)</span>
            <input
              value={teeth}
              onChange={(e) => setTeeth(e.target.value)}
              placeholder="36 or 34-36"
              inputMode="numeric"
              aria-invalid={Boolean(parsed.error)}
            />
          </label>
          <label className="field">
            <span>Due back</span>
            <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </label>
        </div>
        {!addingLab ? (
          <label className="field">
            <span>Lab</span>
            <select
              value={labId}
              onChange={(e) =>
                e.target.value === '__add' ? setAddingLab(true) : setLabId(e.target.value)
              }
            >
              <option value="">Not chosen yet</option>
              {labs.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
              {order?.labId && !labs.some((l) => l.id === order.labId) && (
                <option value={order.labId}>{order.labName ?? 'Previous lab'}</option>
              )}
              <option value="__add">Add a lab…</option>
            </select>
          </label>
        ) : (
          <div className="labsheet__newlab">
            <p className="labsheet__newtitle">New lab</p>
            <div className="grid2">
              <label className="field">
                <span>Name</span>
                <input
                  value={labName}
                  onChange={(e) => setLabName(e.target.value)}
                  autoFocus
                />
              </label>
              <label className="field">
                <span>Phone</span>
                <input
                  type="tel"
                  value={labPhone}
                  onChange={(e) => setLabPhone(e.target.value)}
                  placeholder="069 123 4567"
                />
              </label>
            </div>
            <div className="labsheet__newfoot">
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setAddingLab(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={labName.trim().length < 2}
                onClick={() => void addLab()}
              >
                Add lab
              </button>
            </div>
          </div>
        )}

        <Disclosure summary="Details" hint="Dentist, material, shade, lab price, notes">
          <label className="field">
            <span>Dentist</span>
            <select value={dentistId} onChange={(e) => setDentistId(e.target.value)}>
              <option value="">Not named</option>
              {order?.dentistId && !staff.some((s) => s.id === order.dentistId) && (
                <option value={order.dentistId}>
                  {order.dentistName ?? 'Previous dentist'}
                </option>
              )}
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.fullName}
                </option>
              ))}
            </select>
          </label>
          <div className="grid2">
            <label className="field">
              <span>Material</span>
              <input
                value={material}
                onChange={(e) => setMaterial(e.target.value)}
                placeholder="Zirkon, E-max…"
                maxLength={80}
              />
            </label>
            <label className="field">
              <span>Shade</span>
              <input
                value={shade}
                onChange={(e) => setShade(e.target.value)}
                placeholder="A2"
                maxLength={20}
              />
            </label>
          </div>
          <label className="field">
            <span>Lab price</span>
            <MoneyInput
              value={cost}
              onChange={setCost}
              placeholder="What the lab charges"
            />
          </label>
          <label className="field">
            <span>Notes for the lab</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={1000}
            />
          </label>
        </Disclosure>

        {error && (
          <p className="formerror" role="alert">
            {error}
          </p>
        )}
        <div className="modal__foot">
          <div className="modal__foot-right">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Close
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save' : 'Order lab work'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
