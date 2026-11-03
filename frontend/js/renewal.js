/**
 * js/renewal.js
 * ---------------------------------------------------------------
 * Student page student/renewal.html (#renewal-root).
 * Shows what the SERVER says about this student's renewal (eligibility, deadline, request
 * status) and lets the student request or cancel. The browser never sends a student id,
 * session or status: the server derives everything from the login. External file because
 * the site's Content Security Policy forbids inline scripts.
 * ---------------------------------------------------------------
 */
document.addEventListener('DOMContentLoaded', () => { initRenewalPage(); });

function initRenewalPage() {
  const root = document.getElementById('renewal-root');
  if (!root) return;
  const alertBox = document.getElementById('renewal-alert');
  const body = document.getElementById('renewal-body');

  const STATUS = { pending: ['pending', 'Awaiting review'], approved: ['approved', 'Approved'], rejected: ['failed', 'Rejected'], cancelled: ['neutral', 'Cancelled'], forfeited: ['failed', 'Forfeited'] };
  const badge = (s) => { const [c, l] = STATUS[s] || ['neutral', s]; return `<span class="badge badge-${c}">${escapeHtml(l)}</span>`; };

  async function load() {
    clearAlert(alertBox);
    let d;
    try { d = await api.get('/renewals/status'); } catch (error) { body.innerHTML = ''; showAlert(alertBox, error.message, 'error'); return; }
    render(d);
  }

  function render(d) {
    const sessionLabel = d.session ? escapeHtml(d.session.label) : 'the current session';
    const prev = d.previous_allocation;
    const room = prev ? `<p class="panel-note">Your room: <strong>${escapeHtml(prev.room_number)}</strong> · ${escapeHtml(prev.block_name)} · ${escapeHtml(prev.session_label)}</p>` : '';
    const deadline = d.deadline_at
      ? `<p class="panel-note">Renewal deadline: <strong>${escapeHtml(formatDate(d.deadline_at))}</strong>${d.window_open ? '' : ' (passed)'}</p>`
      : '<p class="panel-note">No renewal deadline has been announced yet.</p>';
    const r = d.renewal;

    if (r && (r.status === 'pending' || r.status === 'approved' || r.status === 'rejected' || r.status === 'forfeited')) {
      let next = '';
      if (r.status === 'pending') next = '<p class="panel-note">Your request is waiting for the hostel administration. Your room stays held for you meanwhile.</p><button class="btn btn-secondary" id="cancel-renewal" type="button">Cancel request</button>';
      else if (r.status === 'approved' && r.room_allocated) next = '<div class="alert alert-success" style="display:block">Your room has been confirmed for the current session.</div>';
      else if (r.status === 'approved') next = '<div class="alert alert-warning" style="display:block">Approved. Pay your hostel fee to complete the renewal; the administration then confirms your room.</div><a class="btn btn-primary" href="/student/payment.html">Go to payment</a>';
      else if (r.status === 'rejected') next = `<p class="panel-note">Reason: ${escapeHtml(r.reason || 'not given')}</p>`;
      else next = `<div class="alert alert-error" style="display:block">Your previous room was released because it was not renewed in time${r.reason ? ` (${escapeHtml(r.reason)})` : ''}. You may submit a normal room application.</div>`;
      body.innerHTML = `<div class="panel"><div class="panel-header"><h3>Renewal for ${sessionLabel}</h3>${badge(r.status)}</div>${room}${deadline}${next}</div>`;
      const cancel = document.getElementById('cancel-renewal');
      if (cancel) cancel.addEventListener('click', async () => {
        clearAlert(alertBox);
        const restore = setButtonLoading(cancel, 'Cancelling…');
        try { await api.post(`/renewals/${r.id}/cancel`); showAlert(alertBox, 'Request cancelled.', 'success'); } catch (error) { showAlert(alertBox, error.message, 'error'); }
        restore(); await load();
      });
      return;
    }

    if (!d.eligible) {
      body.innerHTML = `<div class="panel empty-state"><h3>Renewal is not available</h3><p>${escapeHtml(d.message)}</p>${deadline}
        <a class="btn btn-secondary" href="/student/dashboard.html">Back to dashboard</a></div>`;
      return;
    }

    body.innerHTML = `<div class="panel"><div class="panel-header"><h3>Renew for ${sessionLabel}</h3></div>${room}${deadline}
      <p class="panel-note">Rooms that are not renewed by the deadline are released to other students.</p>
      <button class="btn btn-primary" id="request-renewal" type="button">Request renewal</button></div>`;
    const btn = document.getElementById('request-renewal');
    btn.addEventListener('click', async () => {
      clearAlert(alertBox);
      const restore = setButtonLoading(btn, 'Sending…');
      try { await api.post('/renewals'); showAlert(alertBox, 'Renewal request sent.', 'success'); } catch (error) { showAlert(alertBox, error.message, 'error'); }
      restore(); await load();
    });
  }

  load();
}
