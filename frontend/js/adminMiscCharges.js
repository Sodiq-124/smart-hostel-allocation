/**
 * js/adminMiscCharges.js
 * ---------------------------------------------------------------
 * Admin page for miscellaneous charges (#misc-charges-root).
 * The server (services/miscChargeService.js) enforces every rule: session
 * status, amount/fine validity, "fine needs a deadline", amount/block lock once
 * payments exist, no delete. The buttons here are convenience, not the
 * security boundary. External file because the CSP forbids inline scripts.
 * ---------------------------------------------------------------
 */

document.addEventListener('DOMContentLoaded', () => {
  initMiscChargesPage();
});

function initMiscChargesPage() {
  const root = document.getElementById('misc-charges-root');
  if (!root) return;

  const alertBox = document.getElementById('misc-alert');
  const form = document.getElementById('charge-form');
  const formTitle = document.getElementById('charge-form-title');
  const saveBtn = document.getElementById('charge-save-btn');
  const cancelBtn = document.getElementById('charge-cancel-btn');
  const lockNote = document.getElementById('charge-lock-note');
  const tableBody = document.getElementById('charges-table-body');
  const emptyState = document.getElementById('charges-empty');
  const idField = document.getElementById('charge-id');

  let options = { sessions: [], blocks: [] };
  let charges = [];

  const toLocalInput = (v) => (v ? String(v).replace(' ', 'T').slice(0, 16) : '');

  function fillOptions() {
    const sessionSel = form.elements.hostel_session_id;
    const writable = options.sessions.filter((s) => s.writable);
    sessionSel.innerHTML = writable.length
      ? writable.map((s) => `<option value="${s.id}">${escapeHtml(s.label)} (${escapeHtml(s.status)})</option>`).join('')
      : '<option value="">No upcoming or open session</option>';
    const current = writable.find((s) => s.is_current);
    if (current) sessionSel.value = String(current.id);

    form.elements.block_id.innerHTML =
      '<option value="">All approved students</option>' +
      options.blocks.map((b) => `<option value="${b.id}">${escapeHtml(b.name)} only</option>`).join('');
  }

  function resetForm() {
    form.reset();
    idField.value = '';
    formTitle.textContent = 'New charge';
    saveBtn.textContent = 'Create charge';
    cancelBtn.classList.add('is-hidden');
    lockNote.classList.add('is-hidden');
    form.elements.hostel_session_id.disabled = false;
    form.elements.amount.disabled = false;
    form.elements.block_id.disabled = false;
    fillOptions();
    applyFieldErrors(form, []);
  }

  function startEdit(charge) {
    clearAlert(alertBox);
    idField.value = String(charge.id);
    formTitle.textContent = `Edit charge #${charge.id}`;
    saveBtn.textContent = 'Save changes';
    cancelBtn.classList.remove('is-hidden');
    fillOptions();
    form.elements.hostel_session_id.innerHTML = `<option value="${charge.hostel_session_id}">${escapeHtml(charge.session_label)}</option>`;
    form.elements.hostel_session_id.disabled = true; // a charge never changes session
    form.elements.name.value = charge.name;
    form.elements.description.value = charge.description || '';
    form.elements.amount.value = charge.amount;
    form.elements.block_id.value = charge.block_id === null ? '' : String(charge.block_id);
    form.elements.deadline_at.value = toLocalInput(charge.deadline_at);
    form.elements.late_fine_amount.value = charge.late_fine_amount;
    form.elements.is_required.checked = charge.is_required;
    form.elements.amount.disabled = charge.amount_locked;
    form.elements.block_id.disabled = charge.amount_locked;
    if (charge.amount_locked) {
      lockNote.textContent = 'Payments already exist for this charge, so its amount and block are locked. Title, description, deadline and fine can still change; they only affect future payments.';
      lockNote.classList.remove('is-hidden');
    } else {
      lockNote.classList.add('is-hidden');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function badge(charge) {
    if (charge.read_only) return '<span class="badge badge-neutral">Historical</span>';
    return charge.is_active
      ? '<span class="badge badge-success">Active</span>'
      : '<span class="badge badge-neutral">Inactive</span>';
  }

  function actions(charge) {
    const parts = [];
    if (!charge.read_only) parts.push(`<button class="btn btn-secondary btn-sm" data-action="edit" data-id="${charge.id}">Edit</button>`);
    if (charge.is_active) parts.push(`<button class="btn btn-danger btn-sm" data-action="deactivate" data-id="${charge.id}">Deactivate</button>`);
    else if (!charge.read_only) parts.push(`<button class="btn btn-primary btn-sm" data-action="activate" data-id="${charge.id}">Activate</button>`);
    return parts.join(' ') || '<span class="field-help">No actions</span>';
  }

  function renderTable() {
    if (charges.length === 0) {
      tableBody.innerHTML = '';
      emptyState.classList.remove('is-hidden');
      return;
    }
    emptyState.classList.add('is-hidden');
    tableBody.innerHTML = charges.map((c) => `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong>${c.is_required ? ' <span class="badge badge-pending">Required</span>' : ''}
          ${c.description ? `<div class="field-help">${escapeHtml(c.description)}</div>` : ''}</td>
        <td>${escapeHtml(c.session_label)}<div class="field-help">${c.block_name ? escapeHtml(c.block_name) : 'All approved students'}</div></td>
        <td>${escapeHtml(formatMoney(c.amount, c.currency))}</td>
        <td>${c.deadline_at ? escapeHtml(formatDate(c.deadline_at)) : 'No deadline'}
          <div class="field-help">${Number(c.late_fine_amount) > 0 ? `Late fine ${escapeHtml(formatMoney(c.late_fine_amount, c.currency))}` : 'No late fine'}</div></td>
        <td>${c.paid_count} paid · ${c.pending_count} pending
          <div class="field-help">Collected ${escapeHtml(formatMoney(c.collected_total, c.currency))}</div></td>
        <td>${badge(c)}</td>
        <td>${actions(c)}</td>
      </tr>`).join('');
  }

  async function load() {
    tableBody.innerHTML = '<tr><td colspan="7"><span class="spinner"></span> Loading charges…</td></tr>';
    try {
      [options, charges] = await Promise.all([api.get('/admin/misc-charges/options'), api.get('/admin/misc-charges')]);
    } catch (error) {
      tableBody.innerHTML = '';
      showAlert(alertBox, error.message, 'error');
      return;
    }
    if (!idField.value) fillOptions();
    renderTable();
  }

  function readForm() {
    const f = form.elements;
    const body = {
      name: f.name.value,
      description: f.description.value,
      block_id: f.block_id.value === '' ? null : Number(f.block_id.value),
      deadline_at: f.deadline_at.value === '' ? null : f.deadline_at.value,
      late_fine_amount: f.late_fine_amount.value.trim() === '' ? '0.00' : f.late_fine_amount.value.trim(),
      is_required: f.is_required.checked,
    };
    if (!f.amount.disabled) body.amount = f.amount.value.trim();
    if (!f.block_id.disabled) body.block_id = f.block_id.value === '' ? null : Number(f.block_id.value);
    else delete body.block_id;
    if (!idField.value) body.hostel_session_id = Number(f.hostel_session_id.value);
    return body;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAlert(alertBox);
    applyFieldErrors(form, []);
    const restore = setButtonLoading(saveBtn, 'Saving…');
    try {
      if (idField.value) {
        await api.put(`/admin/misc-charges/${idField.value}`, readForm());
        showAlert(alertBox, 'Charge updated.', 'success');
      } else {
        await api.post('/admin/misc-charges', readForm());
        showAlert(alertBox, 'Charge created.', 'success');
      }
      resetForm();
      await load();
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
      applyFieldErrors(form, error.errors);
    } finally {
      restore();
    }
  });

  cancelBtn.addEventListener('click', () => { clearAlert(alertBox); resetForm(); });

  tableBody.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const charge = charges.find((c) => String(c.id) === button.dataset.id);
    if (!charge) return;
    clearAlert(alertBox);
    if (button.dataset.action === 'edit') { startEdit(charge); return; }
    const verb = button.dataset.action; // activate | deactivate
    if (verb === 'deactivate' && !window.confirm(`Deactivate "${charge.name}"? Students will no longer see it. Existing payments are kept.`)) return;
    try {
      await api.post(`/admin/misc-charges/${charge.id}/${verb}`);
      showAlert(alertBox, verb === 'activate' ? 'Charge activated.' : 'Charge deactivated.', 'success');
      await load();
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
    }
  });

  load();
}
