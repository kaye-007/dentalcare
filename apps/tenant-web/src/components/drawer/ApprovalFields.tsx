import { useEffect, useState } from 'react';
import { drawerApi, type PinApproval } from '../../lib/api';
import { LoadingRows } from '../ui';

/**
 * A manager approving at this desk: who they are, and their own PIN.
 *
 * Never a shared PIN — the approval has to name a person. Managers who have
 * not set a PIN are not offered; they can set one in Settings, or approve
 * from their own signed-in device instead.
 */
export default function ApprovalFields({
  value,
  onChange,
}: {
  value: PinApproval | null;
  onChange: (next: PinApproval | null) => void;
}) {
  const [approvers, setApprovers] = useState<{ id: string; name: string }[] | null>(null);
  const [approverId, setApproverId] = useState(value?.approverUserId ?? '');
  const [pin, setPin] = useState(value?.pin ?? '');

  useEffect(() => {
    drawerApi
      .approvers()
      .then((list) => {
        setApprovers(list);
        if (list.length === 1) setApproverId(list[0]!.id);
      })
      .catch(() => setApprovers([]));
  }, []);

  useEffect(() => {
    onChange(
      approverId && /^\d{4,8}$/.test(pin) ? { approverUserId: approverId, pin } : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approverId, pin]);

  if (approvers === null) return <LoadingRows rows={3} label="Loading managers" />;
  if (approvers.length === 0) {
    return (
      <p className="channel-note" style={{ margin: 0 }}>
        No manager has set an approval PIN yet. An administrator can set one in Settings →
        Features, or approve from their own device.
      </p>
    );
  }

  return (
    <div className="grid2">
      <label className="field">
        <span>Approving manager</span>
        <select
          value={approverId}
          onChange={(e) => setApproverId(e.target.value)}
          required
        >
          <option value="" disabled>
            Choose…
          </option>
          {approvers.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Their PIN</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="\d{4,8}"
          maxLength={8}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          required
        />
      </label>
    </div>
  );
}
