/**
 * js/adminFees.js - admin/fees.html (#fees-root).
 * Convenience only: the server (services/feeAdminService.js) enforces admin-only access,
 * editable session status, amount validity and "history is never overwritten".
 * The browser sends just the session and block (in the URL) and the amount text.
 */
document.addEventListener('DOMContentLoaded', () => { initAdminFeesPage(); });

function initAdminFeesPage() {
  const root = document.getElementById('fees-root');
  if (!root) return;
  const alertBox = document.getElementById('fees-alert');
  const select = document.getElementById('fee-session');
  const note = document.getElementById('fee-session-note');
  const tbody = document.getElementById('fees-table-body');
  const fail = (e) => showAlert(alertBox, e.message, 'error');

  async function loadSessions() {
    try {
      const { sessions } = await api.get('/admin/fees/options');
      select.innerHTML = sessions.map((s) => `<option value="${s.id}">${escapeHtml(s.label)} (${escapeHtml(s.status)}${s.is_current ? ', current' : ''})</option>`).join('');
      const cur = sessions.find((s) => s.is_current) || sessions[0];
      if (cur) select.value = String(cur.id);
      await loadFees();
    } catch (e) { fail(e); }
  }

  async function loadFees() {
    clearAlert(alertBox);
    if (!select.value) { tbody.innerHTML = ''; return; }
    let d;
    try { d = await api.get(`/admin/fees/sessions/${encodeURIComponent(select.value)}`); } catch (e) { tbody.innerHTML = ''; fail(e); return; }
    note.textContent = d.editable ? `Fees for ${d.session.label} can be set or changed.` : `${d.session.label} is ${d.session.status}: its fees are read-only.`;
    tbody.innerHTML = d.blocks.map((b) => {
      const cur = b.fee ? `<strong>${escapeHtml(formatMoney(b.fee.amount, b.fee.currency))}</strong>` : '<span class="badge badge-pending">Not set</span>';
      const earlier = b.earlier_fees.length ? `<br><span class="panel-note">Earlier: ${b.earlier_fees.map((f) => escapeHtml(formatMoney(f.amount, f.currency))).join(', ')}</span>` : '';
      const p = b.payments;
      const pay = p.total ? `${p.paid} paid, ${p.pending} pending (of ${p.total})` : '—';
      const form = d.editable && b.is_active
        ? `<form class="row fee-form" data-block="${b.block_id}" style="gap: var(--sp-2)" novalidate>
             <input type="text" inputmode="decimal" name="amount" placeholder="e.g. 250000" aria-label="Fee for ${escapeHtml(b.block_name)}" style="max-width: 140px" />
             <button class="btn btn-primary btn-sm" type="submit">${b.fee ? 'Change' : 'Set'}</button></form>`
        : (b.is_active ? '' : '<span class="panel-note">Block inactive</span>');
      return `<tr><td>${escapeHtml(b.block_name)}</td><td>${cur}${earlier}</td><td>${pay}</td><td>${form}</td></tr>`;
    }).join('');
  }

  tbody.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('form.fee-form');
    if (!form) return;
    ev.preventDefault();
    clearAlert(alertBox);
    const amount = form.elements.amount.value.trim();
    if (!amount) { showAlert(alertBox, 'Enter an amount.', 'error'); return; }
    const restore = setButtonLoading(form.querySelector('button'), 'Saving…');
    try {
      const r = await api.put(`/admin/fees/sessions/${encodeURIComponent(select.value)}/blocks/${encodeURIComponent(form.dataset.block)}`, { amount });
      showAlert(alertBox, r.changed ? `Fee for ${r.block.name} saved: ${formatMoney(r.fee.amount, r.fee.currency)}.` : 'That is already the current fee. Nothing changed.', r.changed ? 'success' : 'info');
    } catch (e) { fail(e); }
    restore();
    await loadFees();
  });

  select.addEventListener('change', loadFees);
  loadSessions();
}