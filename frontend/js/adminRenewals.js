/**
 * js/adminRenewals.js
 * ---------------------------------------------------------------
 * Admin page admin/renewals.html (#renewals-root). Convenience only: every rule
 * (eligibility, deadline, payment gate, room capacity, exactly-once release) is enforced by
 * services/renewalService.js on the server. External file because the CSP forbids inline scripts.
 * ---------------------------------------------------------------
 */
document.addEventListener('DOMContentLoaded', () => { initAdminRenewalsPage(); });

function initAdminRenewalsPage() {
  const root = document.getElementById('renewals-root');
  if (!root) return;
  const alertBox = document.getElementById('renewals-alert');
  const tableBody = document.getElementById('renewals-table-body');
  const emptyState = document.getElementById('renewals-empty');
  const filter = document.getElementById('status-filter');
  const deadlineForm = document.getElementById('deadline-form');
  const deadlineInput = document.getElementById('deadline-input');
  const deadlineSummary = document.getElementById('deadline-summary');
  const forfeitMessage = document.getElementById('forfeit-message');
  const forfeitLists = document.getElementById('forfeit-lists');
  const runBtn = document.getElementById('forfeit-run');

  const STATUS = { pending: 'pending', approved: 'approved', rejected: 'failed', cancelled: 'neutral', forfeited: 'failed' };
  const badge = (s, label) => `<span class="badge badge-${STATUS[s] || 'neutral'}">${escapeHtml(label || s)}</span>`;
  const fail = (e) => showAlert(alertBox, e.message, 'error');

  async function loadOverview() {
    try {
      const o = await api.get('/admin/renewals/overview');
      deadlineSummary.textContent = o.session
        ? `${o.session.label}: ${o.renewal_deadline_at ? `deadline ${formatDate(o.renewal_deadline_at)}${o.deadline_passed ? ' (passed)' : ''}` : 'no deadline set'}. Pending ${o.counts.pending}, approved ${o.counts.approved}, rejected ${o.counts.rejected}, forfeited ${o.counts.forfeited}.`
        : 'No hostel session is currently open.';
      if (o.renewal_deadline_at) deadlineInput.value = o.renewal_deadline_at.replace(' ', 'T').slice(0, 16);
    } catch (e) { fail(e); }
  }

  function candidateRows(list) {
    return `<ul>${list.map((c) => `<li>${escapeHtml(c.full_name)} · ${escapeHtml(c.block_name)} ${escapeHtml(c.room_number)} · ${escapeHtml(c.session_label)} · allocation #${c.allocation_id}</li>`).join('')}</ul>`;
  }

  async function loadPreview() {
    try {
      const p = await api.get('/admin/renewals/forfeitures/preview');
      forfeitMessage.textContent = p.message || 'The deadline has passed. The allocations below will be forfeited when you run it.';
      const part = (title, list, extra) => list.length ? `<h4>${title} (${list.length})</h4>${extra || ''}${candidateRows(list)}` : '';
      forfeitLists.innerHTML =
        part('Will be forfeited', p.forfeitable) +
        part('Renewal in progress (kept)', p.kept) +
        part('Also holds a current-session room (superseded)', p.superseded, '<p class="panel-note">Not forfeited automatically. Release the old holding with a manual forfeiture if it is a duplicate.</p>');
      if (!forfeitLists.innerHTML) forfeitLists.innerHTML = '<p class="panel-note">No allocations from past sessions are being held.</p>';
      runBtn.classList.toggle('is-hidden', !(p.can_run && p.forfeitable.length));
    } catch (e) { fail(e); }
  }

  function actions(r) {
    const out = [];
    if (r.status === 'pending') out.push(`<button class="btn btn-primary btn-sm" data-act="approve" data-id="${r.id}">Approve</button>`, `<button class="btn btn-secondary btn-sm" data-act="reject" data-id="${r.id}">Reject</button>`);
    if (r.status === 'approved' && !r.fulfilled) out.push(`<button class="btn btn-primary btn-sm" data-act="fulfill" data-id="${r.id}">Confirm room</button>`);
    if (r.previous_allocation_status === 'active') out.push(`<button class="btn btn-danger btn-sm" data-act="forfeit" data-alloc="${r.previous_allocation_id}">Forfeit</button>`);
    return out.join(' ') || '—';
  }

  async function loadList() {
    clearAlert(alertBox);
    try {
      const rows = await api.get(`/admin/renewals${filter.value ? `?status=${encodeURIComponent(filter.value)}` : ''}`);
      emptyState.classList.toggle('is-hidden', rows.length > 0);
      tableBody.innerHTML = rows.map((r) => `<tr>
        <td>${escapeHtml(r.full_name)}<br><span class="panel-note">${escapeHtml(r.matric_number || r.email || '')}</span></td>
        <td>${escapeHtml(r.previous_block_name || '—')} ${escapeHtml(r.previous_room_number || '')}<br><span class="panel-note">${escapeHtml(r.previous_session_label)} → ${escapeHtml(r.new_session_label)}</span></td>
        <td>${badge(r.status)}${r.fulfilled ? ' <span class="badge badge-allocated">Room confirmed</span>' : ''}</td>
        <td>${escapeHtml(r.reason || '')}</td>
        <td>${actions(r)}</td></tr>`).join('');
    } catch (e) { fail(e); }
  }

  const refresh = () => Promise.all([loadOverview(), loadPreview(), loadList()]);

  tableBody.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    clearAlert(alertBox);
    try {
      if (b.dataset.act === 'approve') await api.post(`/admin/renewals/${id}/approve`);
      else if (b.dataset.act === 'reject') {
        const reason = window.prompt('Reason for rejecting this renewal (shown to the student):');
        if (!reason) return;
        await api.post(`/admin/renewals/${id}/reject`, { reason });
      } else if (b.dataset.act === 'fulfill') {
        if (!window.confirm('Confirm the room for this renewal? The student must have paid the hostel fee; the old allocation is released and the same room is allocated for the current session.')) return;
        await api.post(`/admin/renewals/${id}/fulfill`, {});
      } else if (b.dataset.act === 'forfeit') {
        const reason = window.prompt('Reason for forfeiting this student\'s previous-session room:');
        if (!reason) return;
        if (!window.confirm('Forfeit this room now? The allocation is released and the bed space freed.')) return;
        await api.post(`/admin/renewals/forfeitures/allocations/${b.dataset.alloc}`, { reason });
      }
      showAlert(alertBox, 'Done.', 'success');
    } catch (e) { fail(e); }
    refresh();
  });

  deadlineForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearAlert(alertBox);
    const restore = setButtonLoading(document.getElementById('deadline-save'), 'Saving…');
    try {
      await api.put('/admin/renewals/deadline', { renewal_deadline_at: deadlineInput.value || null });
      showAlert(alertBox, 'Renewal deadline saved.', 'success');
    } catch (e) { fail(e); }
    restore(); refresh();
  });

  runBtn.addEventListener('click', async () => {
    if (!window.confirm('Forfeit every allocation listed under "Will be forfeited"? Each room is released and its bed space freed. This cannot be undone from this page.')) return;
    clearAlert(alertBox);
    const restore = setButtonLoading(runBtn, 'Forfeiting…');
    try {
      const r = await api.post('/admin/renewals/forfeitures/run', {});
      showAlert(alertBox, `Forfeited ${r.forfeited.length}; skipped ${r.skipped.length}.`, r.skipped.length ? 'warning' : 'success');
    } catch (e) { fail(e); }
    restore(); refresh();
  });

  document.getElementById('preview-refresh').addEventListener('click', refresh);
  filter.addEventListener('change', loadList);
  refresh();
}
