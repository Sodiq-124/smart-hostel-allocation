/**
 * js/admin.js
 * ---------------------------------------------------------------
 * Mirrors js/student.js: an app-shell guard run on every /admin/ page,
 * plus page-specific logic gated by checking whether that page's
 * container element exists (applications.html has #applications-root).
 *
 * Duplicated rather than shared with student.js because admin pages
 * never load student.js and vice versa - the two areas are visually
 * and behaviourally separate by design (see admin.css's header
 * comment). A student session on an admin page, or an admin session on
 * a student page, is redirected away before either script's
 * page-specific logic runs.
 * ---------------------------------------------------------------
 */

document.addEventListener('DOMContentLoaded', async () => {
  const user = await guardAdminPage();
  if (!user) return;

  initSidebarToggle();
  initLogout();
  loadTopbarSession();
  initApplicationsPage();
});

/* ---------------------------------------------------------------------
   Shell: auth guard, sidebar, logout
   ---------------------------------------------------------------------
   Same UX-only caveat as student.js's guardStudentPage(): this exists
   so an admin page doesn't flash empty content before redirecting. It
   is NOT the security boundary. Every API call this page makes still
   passes through requireRole('admin') on the backend
   (middleware/authMiddleware.js), independently of whatever this
   function decides. */
async function guardAdminPage() {
  let user;
  try {
    user = await api.get('/auth/me', { silent401: true });
  } catch {
    user = null;
  }

  if (!user) {
    window.location.href = `/admin/login.html?next=${encodeURIComponent(window.location.pathname)}`;
    return null;
  }

  if (user.role !== 'admin') {
    window.location.href = '/student/dashboard.html';
    return null;
  }

  const nameEl = document.getElementById('topbar-user-name');
  const avatarEl = document.getElementById('topbar-avatar');
  if (nameEl) nameEl.textContent = user.full_name;
  if (avatarEl) avatarEl.textContent = initials(user.full_name);

  const path = window.location.pathname;
  document.querySelectorAll('.sidebar-link[href]').forEach((link) => {
    if (link.getAttribute('href') === path) link.classList.add('is-active');
  });

  return user;
}

/**
 * Shows the current hostel session in the topbar of every
 * admin page (element #topbar-session, present on each admin page). Display
 * only and best-effort: a failure hides the chip and never blocks the page.
 * Also called by adminSessions.js after an open/close so the chip refreshes.
 */
async function loadTopbarSession() {
  const chip = document.getElementById('topbar-session');
  if (!chip) return;
  try {
    const current = await api.get('/admin/sessions/current', { silent401: true });
    chip.className = current ? 'badge badge-success' : 'badge badge-neutral';
    chip.textContent = current ? `Session ${current.label}: Open` : 'No open session';
  } catch {
    chip.className = 'badge is-hidden';
    chip.textContent = '';
  }
}

function initials(fullName) {
  return (fullName || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function initSidebarToggle() {
  const toggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!toggle || !sidebar) return;

  const open = () => { sidebar.classList.add('is-open'); backdrop?.classList.add('is-open'); };
  const close = () => { sidebar.classList.remove('is-open'); backdrop?.classList.remove('is-open'); };

  toggle.addEventListener('click', open);
  backdrop?.addEventListener('click', close);
}

function initLogout() {
  document.querySelectorAll('[data-action="logout"]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api.post('/auth/logout', undefined, { silent401: true });
      } finally {
        window.location.href = '/admin/login.html';
      }
    });
  });
}

function capitalize(value) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Admin-facing label for an application's badge. The backend's
 * allocation_state / allocation_state_label (see
 * backend/services/allocationStatusService.js) already distinguish
 * "Approved - Awaiting Allocation" from "Allocation Revoked" - both are
 * app.status === 'approved' with app.allocation === null otherwise, so
 * the raw status alone can't tell an admin which one they're looking at.
 * This only changes the badge text/class; it does not change any of the
 * approve/reject/allocate/revoke button logic, which already keys off
 * app.status and app.allocation directly and is unaffected by this.
 */
function adminStatusBadge(app) {
  const cls = app.allocation_state || app.status;
  // The admin vocabulary is its own, distinct from the
  // student-facing allocation_state_label (backend/services/
  // allocationStatusService.js's STATE_LABELS) - "Pending" not "Pending
  // Review", "Allocation Revoked" not "Allocation Revoked — You may
  // reapply" (that call-to-action addresses the student, not the admin
  // reading this list). Falls back to allocation_state_label/status for
  // anything not in this required set (e.g. 'cancelled'), unchanged.
  const ADMIN_LABELS = {
    pending: 'Pending',
    rejected: 'Rejected',
    allocated: 'Approved + Allocated',
    awaiting_allocation: 'Approved + Awaiting Allocation',
    revoked: 'Allocation Revoked',
  };
  const text = ADMIN_LABELS[app.allocation_state] || app.allocation_state_label || capitalize(app.status);
  return `<span class="badge badge-${cls}">${escapeHtml(text)}</span>`;
}

/* ---------------------------------------------------------------------
   Applications (admin/applications.html): list, detail, and the
   review / allocation actions.
   --------------------------------------------------------------------- */
/**
 * PAYMENT-BEFORE-ALLOCATION: how an application's hostel-fee payment looks to an admin.
 * `app.payment` comes from the server, which marks a payment 'paid' only when it is a
 * successful, server-verified hostel-fee payment of the application's own session.
 * Display only: allocation is enforced by the server (services/paymentGate.js).
 */
function adminPaymentBadge(app) {
  if (app.status !== 'approved') return '<span class="field-help">—</span>';
  if (!app.payment) return '<span class="badge badge-none">Unknown</span>';
  const map = {
    paid: ['paid', 'Paid'],
    pending: ['pending', 'Pending'],
    failed: ['failed', 'Failed'],
    unverified: ['pending', 'Unverified'],
    refunded: ['cancelled', 'Refunded'],
    unpaid: ['unpaid', 'Not paid'],
  };
  const [cls, label] = map[app.payment.status] || ['none', capitalize(app.payment.status)];
  return `<span class="badge badge-${cls}">${escapeHtml(label)}</span>`;
}

function capacityAdvisoryHtml(advisory) {
  if (!advisory) return '';
  if (!advisory.available) {
    return `<div class="alert alert-warning" style="display:block">Capacity could not be checked${advisory.reason ? `: ${escapeHtml(advisory.reason)}` : ''}. ${escapeHtml(advisory.disclaimer || '')}</div>`;
  }
  const cls = advisory.level === 'ok' ? 'alert-info' : 'alert-warning';
  return `<div class="alert ${cls}" style="display:block">${escapeHtml(advisory.message)} <strong>${escapeHtml(advisory.disclaimer)}</strong></div>`;
}

function initApplicationsPage() {
  const root = document.getElementById('applications-root');
  if (!root) return;

  const listSection = document.getElementById('applications-list-section');
  const detailSection = document.getElementById('applications-detail-section');
  const tableBody = document.getElementById('applications-table-body');
  const emptyState = document.getElementById('applications-empty');
  const errorBox = document.getElementById('applications-error');
  const filterForm = document.getElementById('applications-filter-form');

  async function loadList() {
    clearAlert(errorBox);
    emptyState.classList.add('is-hidden');
    tableBody.innerHTML = `<tr><td colspan="9"><span class="spinner"></span> Loading applications…</td></tr>`;

    const params = new URLSearchParams();
    if (filterForm.status.value) params.set('status', filterForm.status.value);
    if (filterForm.room_type.value) params.set('room_type', filterForm.room_type.value);
    if (filterForm.payment_status.value) params.set('payment_status', filterForm.payment_status.value);
    if (filterForm.q.value.trim()) params.set('q', filterForm.q.value.trim());

    try {
      const applications = await api.get(`/admin/applications?${params.toString()}`);
      renderTable(applications);
    } catch (error) {
      tableBody.innerHTML = '';
      showAlert(errorBox, error.message, 'error');
    }
  }

  function renderTable(applications) {
    if (applications.length === 0) {
      tableBody.innerHTML = '';
      emptyState.classList.remove('is-hidden');
      return;
    }

    tableBody.innerHTML = applications.map((app) => `
      <tr>
        <td class="num nowrap">#${app.id}</td>
        <td>${escapeHtml(app.student.full_name)}</td>
        <td>${escapeHtml(app.student.email)}</td>
        <td class="nowrap">${capitalize(app.room_type)}</td>
        <td>${escapeHtml(app.preferred_block || 'No preference')}</td>
        <td class="nowrap">${adminStatusBadge(app)}</td>
        <td class="nowrap">${adminPaymentBadge(app)}</td>
        <td class="nowrap">${formatDate(app.applied_at, false)}</td>
        <td class="table-actions nowrap">
          <button class="btn btn-secondary btn-sm" data-view-id="${app.id}">View</button>
        </td>
      </tr>
    `).join('');

    tableBody.querySelectorAll('[data-view-id]').forEach((btn) => {
      btn.addEventListener('click', () => showDetail(btn.dataset.viewId));
    });
  }

  async function showDetail(id) {
    listSection.classList.add('is-hidden');
    detailSection.classList.remove('is-hidden');
    detailSection.innerHTML = `<div class="panel"><span class="spinner"></span> Loading application…</div>`;

    try {
      const app = await api.get(`/admin/applications/${id}`);
      renderDetail(app);
    } catch (error) {
      detailSection.innerHTML = `
        <div class="alert alert-error">${escapeHtml(error.message)}</div>
        <button class="btn btn-secondary" id="back-to-list">Back to list</button>
      `;
      document.getElementById('back-to-list').addEventListener('click', backToList);
    }
  }

  function renderDetail(app) {
    // Distinguish "never yet allocated" from "was allocated,
    // then revoked" using allocation_state - both otherwise show
    // identically as status = 'approved' with allocation === null.
    const notAllocatedText = app.allocation_state === 'revoked'
      ? 'Revoked — this application can be allocated a different room'
      : 'Not yet allocated';

    const allocationRow = app.allocation
      ? `<div class="info-row">
           <span class="info-row-label">Allocated room</span>
           <span class="info-row-value">${escapeHtml(app.allocation.room_number)} (${escapeHtml(app.allocation.block_name)})</span>
         </div>`
      : `<div class="info-row">
           <span class="info-row-label">Allocated room</span>
           <span class="info-row-value">${escapeHtml(notAllocatedText)}</span>
         </div>`;

    const rejectionRow = app.status === 'rejected'
      ? `<div class="info-row">
           <span class="info-row-label">Rejection reason</span>
           <span class="info-row-value">${escapeHtml(app.rejection_reason || 'No reason recorded.')}</span>
         </div>`
      : '';

    const reviewedByRow = app.reviewed_by
      ? `<div class="info-row">
           <span class="info-row-label">Reviewed by</span>
           <span class="info-row-value">${escapeHtml(app.reviewed_by)}</span>
         </div>`
      : '';

    // Approve/Reject only ever appear for a 'pending' application - the
    // backend enforces this independently (adminApplicationController.js
    // refuses to approve/reject anything else), so this is a display
    // convenience, not the actual rule.
    // PAYMENT-BEFORE-ALLOCATION: approving also confirms the block whose fee the student
    // will pay. The block list comes from the server (blocks with an active fee for this
    // application's session); with no stated preference nothing is pre-selected, so no
    // block is ever chosen silently.
    const actionButtons = app.status === 'pending'
      ? `<div class="panel" style="margin-top: var(--sp-5)">
           <div class="panel-header"><h3>Approve and confirm fee block</h3></div>
           <div class="field">
             <label for="approve-block">Block the student will pay for</label>
             <select id="approve-block" disabled><option>Loading blocks…</option></select>
             <p class="field-help">The student pays this block's fee first; a room is allocated only after payment is verified.</p>
           </div>
           <div id="approve-advisory"></div>
           <div class="row" style="margin-top: var(--sp-4); gap: var(--sp-3)">
             <button class="btn btn-primary" id="approve-btn" disabled><i class="fa-solid fa-check"></i> Approve</button>
             <button class="btn btn-danger" id="reject-btn"><i class="fa-solid fa-xmark"></i> Reject</button>
           </div>
         </div>
         <div class="alert" id="review-alert" style="margin-top: var(--sp-4)"></div>`
      : '';

    // Only shown once a room has actually been allocated - the mirror
    // image of allocationSection below, which only shows when it hasn't.
    // An application can never be in both states at once, so these two
    // never appear together.
    const revokeSection = app.allocation
      ? `<div class="row" style="margin-top: var(--sp-5)">
           <button class="btn btn-danger" id="revoke-btn"><i class="fa-solid fa-rotate-left"></i> Revoke this room allocation</button>
         </div>
         <div class="alert" id="revoke-alert" style="margin-top: var(--sp-4)"></div>`
      : '';

    // Only shown once an application is approved and has no room yet -
    // an already-allocated application just shows allocationRow above;
    // a pending/rejected/cancelled one shows neither.
    // PAYMENT-BEFORE-ALLOCATION: the room picker only loads once the server reports a
    // verified, successful payment. Until then this explains why and offers the fee-block
    // control. The server enforces the same rule on allocate, whatever this screen shows.
    const awaitingRoom = app.status === 'approved' && !app.allocation;
    const paid = Boolean(app.payment && app.payment.status === 'paid');
    const feeBlockLocked = Boolean(app.payment && ['paid', 'pending', 'unverified'].includes(app.payment.status));

    const feeBlockSection = awaitingRoom
      ? `<div class="panel" id="fee-block-section" style="margin-top: var(--sp-4)">
           <div class="panel-header"><h3>Fee block and payment</h3>${adminPaymentBadge(app)}</div>
           <div class="info-row">
             <span class="info-row-label">Confirmed fee block</span>
             <span class="info-row-value">${app.fee_block ? escapeHtml(app.fee_block.name) : '<strong>Not confirmed yet</strong>'}</span>
           </div>
           ${app.payment && app.payment.reference ? `
           <div class="info-row">
             <span class="info-row-label">Latest payment</span>
             <span class="info-row-value">${escapeHtml(formatMoney(app.payment.amount, app.payment.currency))} · ${escapeHtml(app.payment.reference)}${app.payment.paid_at ? ` · ${escapeHtml(formatDate(app.payment.paid_at))}` : ''}</span>
           </div>` : ''}
           ${!app.fee_block_supported ? `<div class="alert alert-warning" style="display:block">Fee blocks are not set up on this database yet (migration 019 has not been applied).</div>` : ''}
           ${app.fee_block_supported && !feeBlockLocked ? `
           <div class="field" style="margin-top: var(--sp-3)">
             <label for="fee-block-select">${app.fee_block ? 'Change fee block' : 'Confirm fee block'}</label>
             <select id="fee-block-select" disabled><option>Loading blocks…</option></select>
           </div>
           <div id="fee-block-advisory"></div>
           <button class="btn btn-secondary" id="fee-block-btn" disabled>${app.fee_block ? 'Update fee block' : 'Confirm fee block'}</button>` : ''}
           ${feeBlockLocked && app.fee_block_supported ? `<p class="field-help">The fee block can no longer be changed because a payment exists.</p>` : ''}
           <div class="alert" id="fee-block-alert" style="margin-top: var(--sp-3)"></div>
         </div>`
      : '';

    const allocationSection = awaitingRoom
      ? (paid
        ? `<div class="panel" id="allocation-section" style="margin-top: var(--sp-4)">
             <div class="panel-header"><h3>Allocate a room</h3></div>
             <div class="alert alert-success" style="display:block">Hostel fee paid and verified${app.payment.paid_block_name ? ` for ${escapeHtml(app.payment.paid_block_name)}` : ''}. Rooms are limited to that block.</div>
             <div id="allocation-picker"><span class="spinner"></span> Loading eligible rooms…</div>
           </div>`
        : `<div class="panel" id="allocation-section" style="margin-top: var(--sp-4)">
             <div class="panel-header"><h3>Allocate a room</h3></div>
             <div class="alert alert-warning" style="display:block">${
               app.payment && app.payment.status === 'pending'
                 ? 'Payment is pending and has not been verified yet.'
                 : (app.fee_block ? 'This student has not paid the hostel fee yet.' : 'Confirm a fee block so the student can pay.')
             } A room can be allocated only after a verified, successful payment.</div>
           </div>`)
      : '';

    detailSection.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="back-to-list" style="margin-bottom: var(--sp-4)">
        <i class="fa-solid fa-arrow-left"></i> Back to list
      </button>

      <div class="panel">
        <div class="panel-header">
          <h3>Application #${app.id}</h3>
          ${adminStatusBadge(app)}
        </div>

        <div class="info-row">
          <span class="info-row-label">Student</span>
          <span class="info-row-value">${escapeHtml(app.student.full_name)}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Student ID</span>
          <span class="info-row-value">${escapeHtml(app.student.student_id)}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Email</span>
          <span class="info-row-value">${escapeHtml(app.student.email)}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Room type</span>
          <span class="info-row-value">${capitalize(app.room_type)}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Preferred block</span>
          <span class="info-row-value">${escapeHtml(app.preferred_block || 'No preference')}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Special request</span>
          <span class="info-row-value">${escapeHtml(app.special_request || '—')}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Applied</span>
          <span class="info-row-value">${formatDate(app.applied_at)}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Reviewed</span>
          <span class="info-row-value">${app.reviewed_at ? formatDate(app.reviewed_at) : 'Not yet reviewed'}</span>
        </div>
        ${reviewedByRow}
        ${allocationRow}
        ${app.status === 'approved' && app.allocation ? `
        <div class="info-row">
          <span class="info-row-label">Hostel-fee payment</span>
          <span class="info-row-value">${adminPaymentBadge(app)}</span>
        </div>` : ''}
        ${rejectionRow}
        ${actionButtons}
        ${revokeSection}
      </div>

      ${app.advisory ? capacityAdvisoryHtml(app.advisory) : ''}
      ${feeBlockSection}
      ${allocationSection}
    `;

    document.getElementById('back-to-list').addEventListener('click', backToList);

    if (app.status === 'pending') {
      document.getElementById('approve-btn').addEventListener('click', () => handleApprove(app.id));
      document.getElementById('reject-btn').addEventListener('click', () => handleReject(app.id));
      loadFeeBlockPicker(app, { selectId: 'approve-block', advisoryId: 'approve-advisory', buttonId: 'approve-btn' });
    }

    if (app.status === 'approved' && !app.allocation && app.fee_block_supported && document.getElementById('fee-block-select')) {
      loadFeeBlockPicker(app, { selectId: 'fee-block-select', advisoryId: 'fee-block-advisory', buttonId: 'fee-block-btn' });
      document.getElementById('fee-block-btn').addEventListener('click', () => handleSetFeeBlock(app.id));
    }

    if (app.allocation) {
      document.getElementById('revoke-btn').addEventListener('click', () => handleRevoke(app.id));
    }

    if (app.status === 'approved' && !app.allocation && app.payment && app.payment.status === 'paid') {
      loadAllocationPicker(app.id);
    }
  }

  /**
   * Fills a block <select> from GET /admin/applications/:id/fee-block-options and shows the
   * advisory capacity note for the chosen block. Nothing is chosen for the admin when the
   * student stated no preference. The action button stays disabled until a block is chosen.
   */
  async function loadFeeBlockPicker(app, { selectId, advisoryId, buttonId }) {
    const select = document.getElementById(selectId);
    const advisoryBox = document.getElementById(advisoryId);
    const button = document.getElementById(buttonId);
    if (!select) return;

    try {
      const info = await api.get(`/admin/applications/${app.id}/fee-block-options`);
      if (info.blocks.length === 0) {
        select.innerHTML = '<option value="">No block has an active fee for this session</option>';
        return;
      }
      const preselect = info.fee_block_id || info.preferred_block_id || null;
      select.innerHTML =
        (preselect ? '' : '<option value="">Choose a block…</option>') +
        info.blocks.map((b) => `
          <option value="${b.id}" ${b.id === preselect ? 'selected' : ''}>
            ${escapeHtml(b.name)} — ${escapeHtml(formatMoney(b.amount, b.currency))}${b.id === info.preferred_block_id ? ' (student preference)' : ''}
          </option>`).join('');
      select.disabled = false;

      const refresh = async () => {
        if (button) button.disabled = !select.value;
        if (!select.value) { advisoryBox.innerHTML = ''; return; }
        try {
          const advisory = await api.get(`/admin/applications/${app.id}/fee-block-advisory?block_id=${encodeURIComponent(select.value)}`);
          advisoryBox.innerHTML = capacityAdvisoryHtml(advisory);
        } catch (_) {
          advisoryBox.innerHTML = '';
        }
      };
      select.addEventListener('change', refresh);
      await refresh();
    } catch (error) {
      select.innerHTML = '<option value="">Could not load blocks</option>';
      advisoryBox.innerHTML = `<div class="alert alert-error" style="display:block">${escapeHtml(error.message)}</div>`;
    }
  }

  async function handleSetFeeBlock(id) {
    const select = document.getElementById('fee-block-select');
    const alertBox = document.getElementById('fee-block-alert');
    const btn = document.getElementById('fee-block-btn');
    if (!select || !select.value) return;

    const label = select.selectedOptions[0] ? select.selectedOptions[0].textContent.trim().replace(/\s+/g, ' ') : 'this block';
    if (!window.confirm(`Confirm ${label} as this student's fee block?\n\nThe student will pay this block's fee. Payment does not guarantee a room until allocation succeeds.`)) return;

    const restore = setButtonLoading(btn, 'Saving…');
    try {
      const updated = await api.put(`/admin/applications/${id}/fee-block`, { fee_block_id: Number(select.value) });
      await loadList();
      renderDetail(updated);
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
      restore();
    }
  }

  /**
   * The reverse of handleAllocate. Requires a reason, the
   * same accountability pattern as handleReject - a room is never
   * silently taken back. On success, re-renders the SAME detail view,
   * which will now show the "Allocate a room" picker again (the
   * server-side revoke leaves the application 'approved' with no room,
   * exactly the state that picker already expects).
   */
  async function handleRevoke(applicationId) {
    const alertBox = document.getElementById('revoke-alert');
    const btn = document.getElementById('revoke-btn');

    const reason = window.prompt(
      'Enter a reason for revoking this room allocation (at least 5 characters):'
    );
    if (reason === null) return;

    if (reason.trim().length < 5) {
      showAlert(alertBox, 'Reason must be at least 5 characters.', 'error');
      return;
    }

    if (!window.confirm('This will free up the room and remove it from this application. Continue?')) return;

    const restore = setButtonLoading(btn, 'Revoking…');
    try {
      const updated = await api.post(`/admin/applications/${applicationId}/revoke-allocation`, {
        release_reason: reason.trim(),
      });
      await loadList();
      renderDetail(updated);
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
      restore();
    }
  }

  /**
   * Populates the allocation picker with rooms from
   * GET /api/admin/applications/:id/eligible-rooms - fetched separately
   * from the application detail itself, since eligibility depends on
   * live room occupancy, not anything already sitting in `app`.
   */
  async function loadAllocationPicker(applicationId) {
    const container = document.getElementById('allocation-picker');
    if (!container) return;

    try {
      const result = await api.get(`/admin/applications/${applicationId}/eligible-rooms`);

      if (result.rooms.length === 0) {
        container.innerHTML = `<div class="alert alert-warning">
          No eligible rooms are currently available for this room type in a block matching the student's gender.
        </div>`;
        return;
      }

      container.innerHTML = `
        <div class="field">
          <label for="room-picker">Select a room</label>
          <select id="room-picker">
            ${result.rooms.map((r) => `
              <option value="${r.id}">
                ${escapeHtml(r.room_number)} — ${escapeHtml(r.block_name)}
                (${r.available_spaces} space${Number(r.available_spaces) === 1 ? '' : 's'} free)
              </option>
            `).join('')}
          </select>
        </div>
        <button class="btn btn-primary" id="allocate-btn">Allocate this room</button>
        <div class="alert" id="allocate-alert" style="margin-top: var(--sp-3)"></div>
      `;

      document.getElementById('allocate-btn').addEventListener('click', () => handleAllocate(applicationId));
    } catch (error) {
      container.innerHTML = `<div class="alert alert-error">${escapeHtml(error.message)}</div>`;
    }
  }

  async function handleAllocate(applicationId) {
    const select = document.getElementById('room-picker');
    const alertBox = document.getElementById('allocate-alert');
    const btn = document.getElementById('allocate-btn');
    const roomLabel = select.selectedOptions[0] ? select.selectedOptions[0].textContent.trim() : 'this room';

    if (!window.confirm(`Allocate ${roomLabel} to this student?`)) return;

    const restore = setButtonLoading(btn, 'Allocating…');
    try {
      const updated = await api.post(`/admin/applications/${applicationId}/allocate`, {
        room_id: select.value,
      });
      await loadList();
      renderDetail(updated);
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
      restore();
    }
  }

  /**
   * The review actions an admin can take on a pending application
   * (approve / reject). Both re-fetch the list in the background afterwards
   * (loadList()) so the table is correct if the admin goes back to it,
   * and re-render the detail panel from the response the server just
   * gave back - not from any value already sitting in the browser -
   * so what's on screen always reflects what the database now holds.
   */
  async function handleApprove(id) {
    const alertBox = document.getElementById('review-alert');
    const btn = document.getElementById('approve-btn');
    const blockSelect = document.getElementById('approve-block');

    if (!blockSelect || !blockSelect.value) {
      showAlert(alertBox, 'Choose the block whose fee this student will pay.', 'error');
      return;
    }
    const blockLabel = blockSelect.selectedOptions[0].textContent.trim().replace(/\s+/g, ' ');
    if (!window.confirm(
      `Approve this application with fee block: ${blockLabel}?\n\n` +
      'The student can then pay the hostel fee. A room is allocated only after payment is verified, ' +
      'and payment does not guarantee a room until allocation succeeds.'
    )) return;

    const restore = setButtonLoading(btn, 'Approving…');
    try {
      const updated = await api.put(`/admin/applications/${id}/approve`, { fee_block_id: Number(blockSelect.value) });
      await loadList();
      renderDetail(updated);
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
      restore();
    }
  }

  async function handleReject(id) {
    const alertBox = document.getElementById('review-alert');

    const reason = window.prompt('Enter a reason for rejecting this application (at least 5 characters):');
    if (reason === null) return; // admin cancelled the prompt

    if (reason.trim().length < 5) {
      showAlert(alertBox, 'Rejection reason must be at least 5 characters.', 'error');
      return;
    }

    const btn = document.getElementById('reject-btn');
    const restore = setButtonLoading(btn, 'Rejecting…');
    try {
      const updated = await api.put(`/admin/applications/${id}/reject`, {
        rejection_reason: reason.trim(),
      });
      await loadList();
      renderDetail(updated);
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
      restore();
    }
  }

  function backToList() {
    detailSection.classList.add('is-hidden');
    listSection.classList.remove('is-hidden');
  }

  filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loadList();
  });
  filterForm.addEventListener('reset', () => {
    setTimeout(loadList, 0); // wait for the browser to actually clear the fields first
  });

  loadList();
}
