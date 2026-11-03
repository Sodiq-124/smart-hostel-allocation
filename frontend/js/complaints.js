

document.addEventListener('DOMContentLoaded', () => {
  initComplaintsPage();
});

async function initComplaintsPage() {
  const root = document.getElementById('complaints-root');
  if (!root) return;

  const form = document.getElementById('complaint-form');
  const alertBox = document.getElementById('form-alert');
  const listContainer = document.getElementById('complaints-list');

  async function loadComplaints() {
    listContainer.innerHTML = `<div class="panel"><span class="spinner"></span> Loading your complaints…</div>`;
    try {
      const complaints = await api.get('/complaints/my');
      renderList(complaints);
    } catch (error) {
      listContainer.innerHTML = `<div class="alert alert-error">${escapeHtml(error.message)}</div>`;
    }
  }

  function renderList(complaints) {
    if (complaints.length === 0) {
      listContainer.innerHTML = `
        <div class="panel empty-state">
          <h3>No complaints yet</h3>
          <p>Anything you report about your hostel or room will appear here.</p>
        </div>
      `;
      return;
    }

    listContainer.innerHTML = complaints.map((c) => `
      <div class="panel" style="margin-bottom: var(--sp-4)">
        <div class="panel-header">
          <h3>${escapeHtml(c.subject)}</h3>
          <span class="badge badge-${c.status}">${formatStatus(c.status)}</span>
        </div>

        <div class="info-row">
          <span class="info-row-label">Category</span>
          <span class="info-row-value">${escapeHtml(c.category)}</span>
        </div>
        ${c.room ? `
        <div class="info-row">
          <span class="info-row-label">Room</span>
          <span class="info-row-value">${escapeHtml(c.room.room_number)} (${escapeHtml(c.room.block_name)})</span>
        </div>` : ''}
        <div class="info-row">
          <span class="info-row-label">Submitted</span>
          <span class="info-row-value">${formatDate(c.created_at)}</span>
        </div>

        <p style="margin-top: var(--sp-3); white-space: pre-wrap">${escapeHtml(c.description)}</p>

        ${c.admin_reply
          ? `<div class="alert alert-info" style="margin-top: var(--sp-3)">
               <strong>Response${c.replied_by ? ' from ' + escapeHtml(c.replied_by) : ''}${c.replied_at ? ' · ' + formatDate(c.replied_at) : ''}:</strong>
               <div style="margin-top: var(--sp-2); white-space: pre-wrap">${escapeHtml(c.admin_reply)}</div>
             </div>`
          : `<div class="alert alert-warning" style="margin-top: var(--sp-3)">Awaiting a response from hostel administration.</div>`
        }
      </div>
    `).join('');
  }

  function formatStatus(status) {
    return status.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAlert(alertBox);

    const payload = {
      category: form.category.value.trim(),
      subject: form.subject.value.trim(),
      description: form.description.value.trim(),
    };

    const submitBtn = form.querySelector('button[type="submit"]');
    const restore = setButtonLoading(submitBtn, 'Submitting…');
    try {
      await api.post('/complaints', payload);
      showAlert(alertBox, 'Complaint submitted successfully.', 'success');
      form.reset();
      await loadComplaints();
    } catch (error) {
      if (error.errors && error.errors.length) applyFieldErrors(form, error.errors);
      showAlert(alertBox, error.message, 'error');
    } finally {
      restore();
    }
  });

  loadComplaints();
}
