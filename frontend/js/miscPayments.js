/**
 * js/miscPayments.js
 * ---------------------------------------------------------------
 * Student page student/misc-charges.html (#misc-root).
 * Lists the charges the SERVER says apply to this student, starts a payment
 * for one (the browser sends only the charge id in the URL - never an amount,
 * currency, fine or "paid" flag), and shows payment history with hostel-fee
 * and miscellaneous payments clearly labelled. The return trip from Paystack
 * reuses payment-callback.html -> POST /api/payments/verify.
 * Loaded after payment.js (uses its paymentBadge helper).
 * ---------------------------------------------------------------
 */

document.addEventListener('DOMContentLoaded', () => {
  initMiscPaymentsPage();
});

function initMiscPaymentsPage() {
  const root = document.getElementById('misc-root');
  if (!root) return;

  const alertBox = document.getElementById('misc-alert');
  const body = document.getElementById('misc-body');
  const historyBox = document.getElementById('misc-history');

  const STATUS_LABEL = { unpaid: ['neutral', 'Unpaid'], pending: ['pending', 'Pending'], paid: ['paid', 'Paid'], failed: ['failed', 'Last attempt failed'], refunded: ['neutral', 'Refunded'] };
  const statusBadge = (s) => { const [c, l] = STATUS_LABEL[s] || ['neutral', s]; return `<span class="badge badge-${c}">${escapeHtml(l)}</span>`; };

  function chargeCard(c) {
    const late = c.is_late && Number(c.late_fine_due) > 0;
    const deadline = c.deadline_at
      ? `Deadline: ${escapeHtml(formatDate(c.deadline_at))}${Number(c.late_fine_amount) > 0 ? ` · late fine ${escapeHtml(formatMoney(c.late_fine_amount, c.currency))}` : ''}`
      : 'No deadline';
    let action = '';
    if (c.status === 'paid' && c.paid) {
      action = `<p class="panel-note">Paid ${escapeHtml(formatMoney(c.paid.amount, c.paid.currency))}${Number(c.paid.late_fine_applied) > 0 ? ` (including late fine ${escapeHtml(formatMoney(c.paid.late_fine_applied, c.paid.currency))})` : ''}
        · ${escapeHtml(formatDate(c.paid.paid_at))} · Ref ${escapeHtml(c.paid.reference)}</p>`;
    } else if (c.status === 'pending') {
      action = `<p class="panel-note">A payment is in progress. If you have just paid, it will be confirmed shortly; reload this page to check.</p>`;
    } else {
      action = `
        ${late ? `<div class="alert alert-warning" style="display:block">The deadline has passed. A late fine of ${escapeHtml(formatMoney(c.late_fine_due, c.currency))} applies.</div>` : ''}
        <button class="btn btn-primary" type="button" data-charge="${c.id}">
          <i class="fa-solid fa-lock"></i> Pay ${escapeHtml(formatMoney(c.amount_due, c.currency))} with Paystack
        </button>`;
    }
    return `
      <div class="panel" style="margin-bottom: var(--sp-4)">
        <div class="panel-header"><h3>${escapeHtml(c.name)}${c.is_required ? ' <span class="badge badge-pending">Required</span>' : ''}</h3>${statusBadge(c.status)}</div>
        ${c.description ? `<p>${escapeHtml(c.description)}</p>` : ''}
        <p class="panel-note">Charge: <strong>${escapeHtml(formatMoney(c.amount, c.currency))}</strong> · ${deadline}${c.block_name ? ` · ${escapeHtml(c.block_name)} only` : ''}</p>
        ${action}
      </div>`;
  }

  function renderBody(data) {
    if (!data.eligible) {
      body.innerHTML = `<div class="panel empty-state"><h3>No charges available</h3><p>${escapeHtml(data.message || 'Charges apply once your application is approved.')}</p></div>`;
      return;
    }
    if (data.charges.length === 0) {
      body.innerHTML = `<div class="panel empty-state"><h3>No charges right now</h3><p>There are no charges for you in ${escapeHtml(data.session.label)}.</p></div>`;
      return;
    }
    body.innerHTML = data.charges.map(chargeCard).join('');
  }

  function renderHistory(rows) {
    if (!rows || rows.length === 0) {
      historyBox.innerHTML = '<div class="panel empty-state"><p>No payments yet.</p></div>';
      return;
    }
    historyBox.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Type</th><th>For</th><th>Session</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${rows.map((p) => `
          <tr>
            <td>${escapeHtml(formatDate(p.paid_at || p.created_at))}</td>
            <td>${p.type === 'miscellaneous' ? '<span class="badge badge-pending">Other charge</span>' : '<span class="badge badge-neutral">Hostel fee</span>'}</td>
            <td>${escapeHtml(p.description)}<div class="field-help">${escapeHtml(p.reference)}</div></td>
            <td>${escapeHtml(p.session_label)}</td>
            <td>${escapeHtml(formatMoney(p.amount, p.currency))}${Number(p.late_fine_applied) > 0 ? `<div class="field-help">incl. late fine ${escapeHtml(formatMoney(p.late_fine_applied, p.currency))}</div>` : ''}</td>
            <td>${paymentBadge(p.status)}</td>
          </tr>`).join('')}</tbody></table></div>`;
  }

  async function load() {
    clearAlert(alertBox);
    try {
      const [charges, history] = await Promise.all([api.get('/payments/misc-charges'), api.get('/payments/history')]);
      renderBody(charges);
      renderHistory(history);
    } catch (error) {
      body.innerHTML = '';
      showAlert(alertBox, error.message, 'error');
    }
  }

  body.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-charge]');
    if (!button) return;
    clearAlert(alertBox);
    setButtonLoading(button, 'Preparing secure checkout…');
    try {
      const result = await api.post(`/payments/misc-charges/${encodeURIComponent(button.dataset.charge)}/initialize`);
      window.location.href = result.authorization_url; // server only returns checkout.paystack.com URLs
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
      await load();
    }
  });

  load();
}
