/**
 * js/adminSessions.js
 * ---------------------------------------------------------------
 * Admin session management page. Gated by
 * #sessions-root like every other page script. The admin shell (auth
 * guard, sidebar, logout, topbar session chip) comes from js/admin.js,
 * which is loaded first on every /admin/ page.
 *
 * This page only REQUESTS transitions (create / open / close by id).
 * Every rule - one open session at a time, forward-only lifecycle,
 * label and date validity - is enforced by the server
 * (services/adminSessionService.js); the buttons below are a
 * convenience, not the security boundary.
 * ---------------------------------------------------------------
 */

document.addEventListener('DOMContentLoaded', () => {
  initSessionsPage();
});

const SESSION_STATUS_BADGE = {
  upcoming: ['pending', 'Upcoming'],
  open: ['success', 'Open'],
  closed: ['neutral', 'Closed'],
  archived: ['neutral', 'Archived'],
};

function sessionStatusBadge(status) {
  const [cls, label] = SESSION_STATUS_BADGE[status] || ['neutral', status];
  return `<span class="badge badge-${cls}">${escapeHtml(label)}</span>`;
}

// 'YYYY-MM-DD' -> 'DD/MM/YYYY' without going through Date (no time-zone shift).
function formatDateOnly(value) {
  if (!value) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '—';
}

function sessionDates(session) {
  if (!session.starts_on && !session.ends_on) return 'Not set';
  return `${formatDateOnly(session.starts_on)} – ${formatDateOnly(session.ends_on)}`;
}

function startYearOfLabel(label) {
  return Number(String(label).slice(0, 4));
}

function initSessionsPage() {
  const root = document.getElementById('sessions-root');
  if (!root) return;

  const alertBox = document.getElementById('sessions-alert');
  const currentBody = document.getElementById('current-session-body');
  const tableBody = document.getElementById('sessions-table-body');
  const emptyState = document.getElementById('sessions-empty');
  const form = document.getElementById('create-session-form');
  const createBtn = document.getElementById('create-session-btn');

  let sessions = [];

  async function load() {
    tableBody.innerHTML = '<tr><td colspan="6"><span class="spinner"></span> Loading sessions…</td></tr>';
    emptyState.classList.add('is-hidden');

    try {
      sessions = await api.get('/admin/sessions');
    } catch (error) {
      tableBody.innerHTML = '';
      currentBody.innerHTML = '';
      showAlert(alertBox, error.message, 'error');
      return;
    }

    renderCurrent();
    renderTable();
    suggestNextLabel();
    refreshTopbarSession();
  }

  function currentSession() {
    return sessions.find((s) => s.status === 'open' && s.is_current) || null;
  }

  function renderCurrent() {
    const current = currentSession();
    if (!current) {
      currentBody.innerHTML = `
        <p><strong>No session is open.</strong></p>
        <p class="panel-note">Until a session is opened, students cannot apply, pay or be allocated a room.</p>`;
      return;
    }
    currentBody.innerHTML = `
      <div class="row" style="gap: var(--sp-3); align-items: center">
        <strong style="font-size: var(--fs-md)">${escapeHtml(current.label)}</strong>
        ${sessionStatusBadge(current.status)}
      </div>
      <p class="panel-note">
        Dates: ${escapeHtml(sessionDates(current))} ·
        ${current.applications_total} application(s) ·
        ${current.active_allocations} active allocation(s)
      </p>`;
  }

  // The earliest upcoming session is the only one the server will let an admin open.
  function earliestUpcoming() {
    const upcoming = sessions.filter((s) => s.status === 'upcoming');
    if (upcoming.length === 0) return null;
    return upcoming.reduce((a, b) => (startYearOfLabel(a.label) <= startYearOfLabel(b.label) ? a : b));
  }

  function actionCell(session) {
    if (session.status === 'upcoming') {
      const current = currentSession();
      const first = earliestUpcoming();
      if (current) {
        return `<button class="btn btn-secondary btn-sm" disabled title="Close ${escapeHtml(current.label)} first">Open</button>
                <div class="field-help">Close ${escapeHtml(current.label)} first.</div>`;
      }
      if (first && first.id !== session.id) {
        return `<button class="btn btn-secondary btn-sm" disabled>Open</button>
                <div class="field-help">Open ${escapeHtml(first.label)} first.</div>`;
      }
      return `<button class="btn btn-primary btn-sm" data-action="open" data-id="${session.id}">Open</button>`;
    }
    if (session.status === 'open') {
      return `<button class="btn btn-danger btn-sm" data-action="close" data-id="${session.id}">Close</button>`;
    }
    return '<span class="field-help">No actions</span>';
  }

  function renderTable() {
    if (sessions.length === 0) {
      tableBody.innerHTML = '';
      emptyState.classList.remove('is-hidden');
      return;
    }
    tableBody.innerHTML = sessions.map((s) => `
      <tr>
        <td><strong>${escapeHtml(s.label)}</strong>${s.is_current ? ' <span class="badge badge-success">Current</span>' : ''}</td>
        <td>${sessionStatusBadge(s.status)}</td>
        <td>${escapeHtml(sessionDates(s))}</td>
        <td>${s.applications_total}
          <span class="field-help">${s.applications_pending} pending · ${s.applications_awaiting_room} approved, no room</span></td>
        <td>${s.active_allocations}</td>
        <td>${actionCell(s)}</td>
      </tr>`).join('');
  }

  // Pre-fill the next label only when the field is empty.
  function suggestNextLabel() {
    const input = form.elements.label;
    if (input.value || sessions.length === 0) return;
    const latest = sessions.reduce((a, b) => (startYearOfLabel(a.label) >= startYearOfLabel(b.label) ? a : b));
    const next = startYearOfLabel(latest.label) + 1;
    input.placeholder = `${next}/${next + 1}`;
  }

  async function refreshTopbarSession() {
    if (typeof loadTopbarSession === 'function') loadTopbarSession();
  }

  async function transition(action, id) {
    const session = sessions.find((s) => s.id === id);
    if (!session) return;

    let confirmText;
    if (action === 'open') {
      confirmText = `Open session ${session.label} and make it the current session?`;
    } else {
      confirmText =
        `Close session ${session.label}?\n\n` +
        `Currently: ${session.applications_pending} pending application(s), ` +
        `${session.applications_awaiting_room} approved without a room, ` +
        `${session.active_allocations} active allocation(s).\n\n` +
        'While no session is open, students cannot apply, pay or be allocated a room. ' +
        'Existing applications, allocations and payments are not changed, and a closed session cannot be reopened.';
    }
    if (!window.confirm(confirmText)) return;

    clearAlert(alertBox);
    try {
      const updated = await api.post(`/admin/sessions/${id}/${action}`);
      await load();
      showAlert(
        alertBox,
        action === 'open'
          ? `Session ${updated.label} is now open and current.`
          : `Session ${updated.label} is now closed. No applications, allocations or payments were changed.`,
        'success'
      );
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
      await load(); // the list may be stale (another admin acted); refresh it
    }
  }

  tableBody.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    transition(button.dataset.action, Number(button.dataset.id));
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAlert(alertBox);
    applyFieldErrors(form, []);

    const payload = { label: form.elements.label.value.trim() };
    if (form.elements.starts_on.value) payload.starts_on = form.elements.starts_on.value;
    if (form.elements.ends_on.value) payload.ends_on = form.elements.ends_on.value;

    const restore = setButtonLoading(createBtn, 'Creating…');
    try {
      const created = await api.post('/admin/sessions', payload);
      form.reset();
      await load();
      showAlert(alertBox, `Session ${created.label} created as upcoming.`, 'success');
    } catch (error) {
      if (error.errors && error.errors.length) {
        applyFieldErrors(form, error.errors);
      }
      showAlert(alertBox, error.message, 'error');
    } finally {
      restore();
    }
  });

  load();
}
