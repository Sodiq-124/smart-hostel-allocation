/**
 * js/adminComplaints.js
 * ---------------------------------------------------------------
 * Admin-side complaint management. Gated by #admin-complaints-root.
 * A separate file from js/rooms.js and js/admin.js, following the
 * same one-file-per-feature-area convention - admin.js is the shell
 * plus its primary (applications) page, and each additional admin
 * feature area (rooms, now complaints) gets its own file.
 * ---------------------------------------------------------------
 */

document.addEventListener('DOMContentLoaded', () => {
  initAdminComplaintsPage();
});

function initAdminComplaintsPage() {
  const root = document.getElementById('admin-complaints-root');
  if (!root) return;

  const listSection = document.getElementById('complaints-list-section');
  const detailSection = document.getElementById('complaints-detail-section');
  const tableBody = document.getElementById('complaints-table-body');
  const emptyState = document.getElementById('complaints-empty');
  const errorBox = document.getElementById('complaints-error');
  const filterForm = document.getElementById('complaints-filter-form');

  async function loadList() {
    clearAlert(errorBox);
    emptyState.classList.add('is-hidden');
    tableBody.innerHTML = `<tr><td colspan="6"><span class="spinner"></span> Loading complaints…</td></tr>`;

    const params = new URLSearchParams();
    if (filterForm.status.value) params.set('status', filterForm.status.value);
    if (filterForm.q.value.trim()) params.set('q', filterForm.q.value.trim());

    try {
      const complaints = await api.get(`/admin/complaints?${params.toString()}`);
      renderTable(complaints);
    } catch (error) {
      tableBody.innerHTML = '';
      showAlert(errorBox, error.message, 'error');
    }
  }

  function renderTable(complaints) {
    if (complaints.length === 0) {
      tableBody.innerHTML = '';
      emptyState.classList.remove('is-hidden');
      return;
    }

    tableBody.innerHTML = complaints.map((c) => `
      <tr>
        <td>${escapeHtml(c.student.full_name)}</td>
        <td>${escapeHtml(c.subject)}</td>
        <td>${escapeHtml(c.category)}</td>
        <td class="nowrap"><span class="badge badge-${c.status}">${formatStatus(c.status)}</span></td>
        <td class="nowrap">${formatDate(c.created_at, false)}</td>
        <td class="table-actions nowrap">
          <button class="btn btn-secondary btn-sm" data-view-id="${c.id}">View</button>
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
    detailSection.innerHTML = `<div class="panel"><span class="spinner"></span> Loading complaint…</div>`;

    try {
      const complaint = await api.get(`/admin/complaints/${id}`);
      renderDetail(complaint);
    } catch (error) {
      detailSection.innerHTML = `
        <div class="alert alert-error">${escapeHtml(error.message)}</div>
        <button class="btn btn-secondary" id="back-to-list">Back to list</button>
      `;
      document.getElementById('back-to-list').addEventListener('click', backToList);
    }
  }

  function renderDetail(c) {
    detailSection.innerHTML = `
      <button class="btn btn-secondary btn-sm" id="back-to-list" style="margin-bottom: var(--sp-4)">
        <i class="fa-solid fa-arrow-left"></i> Back to list
      </button>

      <div class="panel">
        <div class="panel-header">
          <h3>${escapeHtml(c.subject)}</h3>
          <span class="badge badge-${c.status}">${formatStatus(c.status)}</span>
        </div>

        <div class="info-row">
          <span class="info-row-label">Student</span>
          <span class="info-row-value">${escapeHtml(c.student.full_name)}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Student ID</span>
          <span class="info-row-value">${escapeHtml(c.student.student_id)}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Email</span>
          <span class="info-row-value">${escapeHtml(c.student.email)}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Category</span>
          <span class="info-row-value">${escapeHtml(c.category)}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Room</span>
          <span class="info-row-value">${c.room ? escapeHtml(c.room.room_number) + ' (' + escapeHtml(c.room.block_name) + ')' : 'No allocation on record'}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Submitted</span>
          <span class="info-row-value">${formatDate(c.created_at)}</span>
        </div>

        <div style="margin-top: var(--sp-4)">
          <div class="info-row-label" style="margin-bottom: var(--sp-2)">Description</div>
          <p style="white-space: pre-wrap">${escapeHtml(c.description)}</p>
        </div>

        <div class="field" style="margin-top: var(--sp-4)">
          <label for="status-select">Status</label>
          <select id="status-select">
            <option value="open" ${c.status === 'open' ? 'selected' : ''}>Open</option>
            <option value="in_progress" ${c.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
            <option value="resolved" ${c.status === 'resolved' ? 'selected' : ''}>Resolved</option>
          </select>
        </div>

        <div class="field">
          <label for="reply-textarea">Reply to student</label>
          <textarea id="reply-textarea" maxlength="2000" placeholder="Write a response the student will see…">${escapeHtml(c.admin_reply || '')}</textarea>
          ${c.replied_by ? `<p class="field-help">Last replied by ${escapeHtml(c.replied_by)}${c.replied_at ? ' · ' + formatDate(c.replied_at) : ''}</p>` : ''}
        </div>

        <div class="alert" id="save-alert" style="margin-top: var(--sp-3)"></div>
        <button class="btn btn-primary" id="save-complaint-btn">Save changes</button>
      </div>
    `;

    document.getElementById('back-to-list').addEventListener('click', backToList);
    document.getElementById('save-complaint-btn').addEventListener('click', () => handleSave(c));
  }

  async function handleSave(original) {
    const alertBox = document.getElementById('save-alert');
    const btn = document.getElementById('save-complaint-btn');
    const statusSelect = document.getElementById('status-select');
    const replyTextarea = document.getElementById('reply-textarea');

    const payload = { status: statusSelect.value };

    // Only include admin_reply if it actually changed - otherwise
    // resaving with no real edit would needlessly bump replied_at/
    // replied_by on the server for a reply that didn't change.
    const newReply = replyTextarea.value.trim();
    const originalReply = (original.admin_reply || '').trim();
    if (newReply !== originalReply) {
      payload.admin_reply = newReply;
    }

    const restore = setButtonLoading(btn, 'Saving…');
    try {
      const updated = await api.put(`/admin/complaints/${original.id}`, payload);
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

  function formatStatus(status) {
    return status.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loadList();
  });
  filterForm.addEventListener('reset', () => {
    setTimeout(loadList, 0);
  });

  loadList();
}
