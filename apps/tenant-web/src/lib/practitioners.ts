import { appointmentsApi, type StaffMember } from './api';
import { isPractitioner } from './permissions';

/**
 * Who can be booked: active people who see patients (Staff › Sees patients).
 * A clinic that has not marked anyone yet still gets its dentists, hygienists
 * and administrators, rather than an empty list — the same rule the API's
 * find-times uses.
 */
export async function loadPractitioners(): Promise<StaffMember[]> {
  const list = await appointmentsApi.staff();
  const active = list.filter((s) => s.status === 'active');
  const flagged = active.filter((s) => s.seesPatients);
  return flagged.length > 0 ? flagged : active.filter((s) => isPractitioner(s.role));
}
