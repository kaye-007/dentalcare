import { NavLink, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/ui';
import RemindersTab from '../components/whatsapp/RemindersTab';
import HistoryTab from '../components/whatsapp/HistoryTab';
import TemplatesTab from '../components/whatsapp/TemplatesTab';
import SettingsTab from '../components/whatsapp/SettingsTab';

/**
 * Messages: WhatsApp appointment reminders from the clinic's own number.
 *
 *   reminders   tomorrow's appointments, who can be reminded and why not,
 *               preview and send — the front desk's page
 *   history     every send and what WhatsApp said about it
 *   templates   the approved Meta templates and their local preview
 *   settings    the clinic's WhatsApp Cloud API connection
 *
 * Connect once, then: open Messages → select tomorrow's patients → preview →
 * send → check the history.
 */
const TABS = [
  { key: '', label: 'Appointment reminders', manage: false },
  { key: 'history', label: 'Send history', manage: false },
  { key: 'templates', label: 'Message templates', manage: true },
  { key: 'settings', label: 'WhatsApp settings', manage: true },
] as const;

export default function MessagesPage() {
  const { can } = useAuth();
  const { tab = '' } = useParams();
  const manage = can('settings:manage');
  const visible = TABS.filter((t) => !t.manage || manage);
  if (!visible.some((t) => t.key === tab)) return <Navigate to="/messages" replace />;

  return (
    <div className="page">
      <PageHeader
        title="Messages"
        meta="WhatsApp appointment reminders from the clinic’s own number"
      />
      <nav className="tabs wa-tabs" aria-label="Messages">
        {visible.map((t) => (
          <NavLink
            key={t.key}
            to={t.key ? `/messages/${t.key}` : '/messages'}
            end
            className={({ isActive }) => `tab${isActive ? ' tab--active' : ''}`}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      {tab === '' && <RemindersTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
}
