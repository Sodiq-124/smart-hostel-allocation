/**
 * js/payment.js
 * ---------------------------------------------------------------
 * Two pages share this file (guarded by their root element, like the
 * rest of the student pages):
 *
 *   student/payment.html           #payment-root   - shows the fee the
 *       SERVER calculated, and starts a payment.
 *   student/payment-callback.html  #callback-root  - where Paystack sends
 *       the student back. It only passes the reference to the server,
 *       which asks Paystack what really happened.
 *
 * The browser never sends an amount, a currency or a "paid" flag, and
 * nothing here decides that a payment succeeded: it only displays what
 * the server reports. (External file because the site's Content
 * Security Policy forbids inline scripts.)
 * ---------------------------------------------------------------
 */

document.addEventListener('DOMContentLoaded', () => {
  initPaymentPage();
  initCallbackPage();
});

const PAYMENT_STATUS_LABEL = {
  success: ['paid', 'Paid'],
  pending: ['pending', 'Pending'],
  failed: ['failed', 'Failed'],
  abandoned: ['failed', 'Not completed'],
  refunded: ['neutral', 'Refunded'],
};

function paymentBadge(status) {
  const [cls, label] = PAYMENT_STATUS_LABEL[status] || ['neutral', status];
  return `<span class="badge badge-${cls}">${escapeHtml(label)}</span>`;
}

/* ------------------------------ payment.html ------------------------------ */

async function initPaymentPage() {
  const root = document.getElementById('payment-root');
  if (!root) return;

  const alertBox = document.getElementById('payment-alert');
  const body = document.getElementById('payment-body');
  const historyBox = document.getElementById('payment-history');

  async function load() {
    clearAlert(alertBox);
    let data;
    try {
      data = await api.get('/payments/status');
    } catch (error) {
      body.innerHTML = '';
      showAlert(alertBox, error.message, 'error');
      return;
    }
    renderBody(data);
    renderHistory(data.history);
  }

  function renderBody(data) {
    if (data.paid) {
      body.innerHTML = `
        <div class="panel">
          <div class="panel-header"><h3>Hostel fee</h3>${paymentBadge('success')}</div>
          <p>Your hostel fee for ${escapeHtml(data.session ? data.session.label : 'this session')} has been paid.</p>
          ${data.application && data.application.room_allocated ? '' : '<p class="panel-note">The hostel administration will now allocate your room. Payment does not guarantee a room until allocation succeeds.</p>'}
          <p class="panel-note">Amount: <strong>${escapeHtml(formatMoney(data.paid.amount, data.paid.currency))}</strong>
             · Reference: ${escapeHtml(data.paid.payment_reference)}
             · Paid: ${escapeHtml(formatDate(data.paid.paid_at))}</p>
        </div>`;
      return;
    }

    if (!data.eligible) {
      body.innerHTML = `
        <div class="panel empty-state">
          <h3>Payment is not available yet</h3>
          <p>${escapeHtml(data.message || 'Payment opens once your application is approved and your fee block is confirmed.')}</p>
          <a class="btn btn-secondary" href="/student/dashboard.html">Back to dashboard</a>
        </div>`;
      return;
    }

    const fee = data.fee;
    // An attempt that is still pending: do not offer a second payment (the server would refuse it
    // anyway). Let the student ask the server to re-check it with Paystack instead.
    const pendingAttempt = (data.history || []).find((p) => p.status === 'pending');
    if (pendingAttempt) {
      body.innerHTML = `
        <div class="panel">
          <div class="panel-header"><h3>Hostel fee — ${escapeHtml(data.session.label)}</h3>${paymentBadge('pending')}</div>
          <p style="font-size: var(--fs-2xl, 1.75rem); font-weight: 700; margin: 0 0 var(--sp-2)">${escapeHtml(formatMoney(fee.amount, fee.currency))}</p>
          <p class="panel-note">${escapeHtml(fee.block_name)}${fee.room_number ? ` · Room ${escapeHtml(fee.room_number)}` : ''}</p>
          <div class="alert alert-warning" style="display:block">A payment has been started but not confirmed yet. If you have already paid, check the status below. If you closed the Paystack page without paying, check again and then you can start a new payment.</div>
          <button class="btn btn-primary btn-block" id="check-pending-button" type="button">Check payment status</button>
          <button class="btn btn-secondary btn-block" id="restart-pending-button" type="button" style="margin-top: var(--sp-2)">Start a new payment</button>
          <p class="field-help">"Start a new payment" is only accepted by the server when no earlier attempt is paid or still in progress, so you cannot be charged twice.</p>
        </div>`;
      // The server settles or closes the earlier attempt first and refuses (409) if it was paid or is genuinely in progress.
      document.getElementById('restart-pending-button').addEventListener('click', (event) => startPayment(event.currentTarget));
      document.getElementById('check-pending-button').addEventListener('click', async () => {
        const button = document.getElementById('check-pending-button');
        clearAlert(alertBox);
        const restore = setButtonLoading(button, 'Checking with Paystack…');
        try {
          const result = await api.post('/payments/verify', { reference: pendingAttempt.payment_reference });
          if (result.status === 'success') showAlert(alertBox, 'Payment confirmed. Thank you.', 'success');
        } catch (error) {
          showAlert(alertBox, error.message, 'error');
        }
        restore();
        await load();
      });
      return;
    }

    // Latest attempt failed or was cancelled/abandoned at Paystack: say so, then offer a retry.
    const lastAttempt = (data.history || [])[0];
    const lastFailed = lastAttempt && (lastAttempt.status === 'failed' || lastAttempt.status === 'abandoned');
    body.innerHTML = `
      <div class="panel">
        <div class="panel-header"><h3>Hostel fee — ${escapeHtml(data.session.label)}</h3>${lastFailed ? paymentBadge(lastAttempt.status) : ''}</div>
        ${lastFailed ? '<div class="alert alert-warning" style="display:block">Your last payment attempt was not completed (it failed or was cancelled), so you have not been charged for it. You can try again below.</div>' : ''}
        <p style="font-size: var(--fs-2xl, 1.75rem); font-weight: 700; margin: 0 0 var(--sp-2)">
          ${escapeHtml(formatMoney(fee.amount, fee.currency))}
        </p>
        <p class="panel-note">${escapeHtml(fee.block_name)}${fee.room_number ? ` · Room ${escapeHtml(fee.room_number)}` : ''}. Electricity is included in the block fee.</p>
        ${data.application && data.application.room_allocated ? '' : '<p class="panel-note">A room is allocated after your payment is verified. Payment does not guarantee a room until allocation succeeds.</p>'}
        <button class="btn btn-primary btn-block" id="pay-button" type="button">
          <i class="fa-solid fa-lock"></i> ${lastFailed ? 'Try again — pay' : 'Pay'} ${escapeHtml(formatMoney(fee.amount, fee.currency))} hostel fee with Paystack
        </button>
      </div>`;
    document.getElementById('pay-button').addEventListener('click', (event) => startPayment(event.currentTarget));
  }

  function renderHistory(history) {
    if (!history || history.length === 0) {
      historyBox.innerHTML = `<div class="panel empty-state"><p>No payment attempts yet.</p></div>`;
      return;
    }
    historyBox.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Reference</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${history.map((p) => `
          <tr>
            <td>${escapeHtml(formatDate(p.paid_at || p.created_at))}</td>
            <td>${escapeHtml(p.payment_reference)}</td>
            <td>${escapeHtml(formatMoney(p.amount, p.currency))}</td>
            <td>${paymentBadge(p.status)}</td>
          </tr>`).join('')}
        </tbody></table></div>`;
  }

  async function startPayment(button) {
    const paymentButton = button || document.getElementById('pay-button');
    clearAlert(alertBox);
    const restore = setButtonLoading(paymentButton, 'Preparing secure checkout…');

    try {
      const result = await api.post('/payments/initialize');
      // Paystack's hosted checkout (the server only returns checkout.paystack.com URLs).
      window.location.href = result.authorization_url;
    } catch (error) {
      restore();
      showAlert(alertBox, error.message, 'error');
      await load();
    }
  }

  load();
}

/* --------------------------- payment-callback.html --------------------------- */

async function initCallbackPage() {
  const root = document.getElementById('callback-root');
  if (!root) return;

  const body = document.getElementById('callback-body');
  const params = new URLSearchParams(window.location.search);
  // Paystack appends ?trxref=...&reference=... ; both are just lookup keys.
  const reference = params.get('reference') || params.get('trxref');

  if (!reference) {
    body.innerHTML = `
      <div class="panel empty-state"><h3>No payment to check</h3>
        <p>Open this page from the payment screen.</p>
        <a class="btn btn-secondary" href="/student/payment.html">Go to payment</a></div>`;
    return;
  }
  // keep the reference out of the address bar / history after reading it
  window.history.replaceState(null, '', window.location.pathname);

  async function check() {
    body.innerHTML = `<div class="panel"><span class="spinner"></span> Confirming your payment with Paystack…</div>`;
    let result;
    try {
      result = await api.post('/payments/verify', { reference });
    } catch (error) {
      body.innerHTML = `
        <div class="alert alert-error" style="display:block">${escapeHtml(error.message)}</div>
        <div class="row" style="gap: var(--sp-3)">
          <button class="btn btn-primary" id="retry-check" type="button">Check again</button>
          <a class="btn btn-secondary" href="/student/payment.html">Back to payment</a>
        </div>`;
      document.getElementById('retry-check').addEventListener('click', check);
      return;
    }

    const { status, payment } = result;
    // The server says which kind of payment this reference was.
    const isMisc = payment.payment_type === 'miscellaneous';
    const backHref = isMisc ? '/student/misc-charges.html' : '/student/payment.html';
    const amount = escapeHtml(formatMoney(payment.amount, payment.currency));
    const ref = escapeHtml(payment.reference);

    if (status === 'success') {
      body.innerHTML = `
        <div class="alert alert-success" style="display:block"><strong>Payment confirmed.</strong> Thank you.</div>
        <div class="panel"><p>Amount: <strong>${amount}</strong></p>
          <p class="panel-note">Reference: ${ref}${payment.paid_at ? ' · ' + escapeHtml(formatDate(payment.paid_at)) : ''}</p>
          <a class="btn btn-primary" href="/student/dashboard.html">Go to dashboard</a></div>`;
    } else if (status === 'pending') {
      body.innerHTML = `
        <div class="alert alert-warning" style="display:block">Your payment has not been confirmed yet. If you have just paid, wait a moment and check again.</div>
        <div class="row" style="gap: var(--sp-3)">
          <button class="btn btn-primary" id="retry-check" type="button">Check again</button>
          <a class="btn btn-secondary" href="${backHref}">Back to payment</a></div>
        <p class="panel-note">Reference: ${ref}</p>`;
      document.getElementById('retry-check').addEventListener('click', check);
    } else {
      body.innerHTML = `
        <div class="alert alert-error" style="display:block">This payment was not completed and you have not been charged.</div>
        <div class="row" style="gap: var(--sp-3)">
          <a class="btn btn-primary" href="${backHref}">Try again</a>
          <a class="btn btn-secondary" href="/student/dashboard.html">Dashboard</a></div>
        <p class="panel-note">Reference: ${ref}</p>`;
    }
  }

  check();
}

