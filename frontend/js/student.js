/**
 * js/student.js
 * ---------------------------------------------------------------
 * Two responsibilities:
 *
 *  1. The APP SHELL, run on every page under /student/: confirm the
 *     visitor is actually a logged-in student (not just "logged in" -
 *     an admin session must not see this shell either), fill in their
 *     name, and wire the sidebar/logout controls that appear on every
 *     page.
 *
 *  2. PAGE-SPECIFIC logic, guarded by checking whether that page's
 *     container element exists - the same pattern used in auth.js.
 *     dashboard.html has #dashboard-root; profile.html has
 *     #profile-form. A page with neither element simply skips both.
 * ---------------------------------------------------------------
 */

document.addEventListener('DOMContentLoaded', async () => {
  const user = await guardStudentPage();
  if (!user) return; // guardStudentPage already redirected away

  initSidebarToggle();
  initLogout();
  initDashboardPage(user);
  initProfilePage(user);
});

/* ---------------------------------------------------------------------
   Shell: auth guard, sidebar, logout
   --------------------------------------------------------------------- */

/**
 * Confirms a real, active STUDENT session before showing anything.
 * Every /student/ page calls this first. Note this is a UX convenience
 * only - it stops a student from staring at an empty shell while a
 * background fetch 401s. The actual security boundary is
 * requireRole('student') on the backend (middleware/authMiddleware.js),
 * which runs again on every single API call this page makes.
 */
async function guardStudentPage() {
  let user;
  try {
    user = await api.get('/auth/me', { silent401: true });
  } catch {
    user = null;
  }

  if (!user) {
    window.location.href = `/login.html?next=${encodeURIComponent(window.location.pathname)}`;
    return null;
  }

  if (user.role !== 'student') {
    // Same fix as auth.js: no admin dashboard exists in any phase yet.
    window.location.href = '/admin/applications.html';
    return null;
  }

  // Fill in the topbar: initials avatar + name, present on every page.
  const nameEl = document.getElementById('topbar-user-name');
  const avatarEl = document.getElementById('topbar-avatar');
  if (nameEl) nameEl.textContent = user.full_name;
  if (avatarEl) avatarEl.textContent = initials(user.full_name);

  // Mark the sidebar link matching the current page as active.
  const path = window.location.pathname;
  document.querySelectorAll('.sidebar-link[href]').forEach((link) => {
    if (link.getAttribute('href') === path) link.classList.add('is-active');
  });

  return user;
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
        window.location.href = '/login.html';
      }
    });
  });
}

/* ---------------------------------------------------------------------
   Dashboard (student/dashboard.html)
   --------------------------------------------------------------------- */
async function initDashboardPage(user) {
  const root = document.getElementById('dashboard-root');
  if (!root) return;

  const els = {
    appStatus:   document.getElementById('stat-application-status'),
    appMeta:     document.getElementById('stat-application-meta'),
    roomStatus:  document.getElementById('stat-room-status'),
    roomMeta:    document.getElementById('stat-room-meta'),
    payStatus:   document.getElementById('stat-payment-status'),
    payMeta:     document.getElementById('stat-payment-meta'),
    greeting:    document.getElementById('dashboard-greeting'),
    ctaBox:      document.getElementById('dashboard-cta'),
  };

  if (els.greeting) els.greeting.textContent = `Welcome back, ${user.full_name.split(' ')[0]}.`;

  try {
    const data = await api.get('/students/dashboard');
    renderDashboard(data, els);
  } catch (error) {
    root.innerHTML = `<div class="alert alert-error">${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Dashboard-only short labels for the main application-status stat.
 * The backend's allocation_state_label is intentionally
 * detailed (e.g. "Allocated — Block B, Room R012") for use on the My
 * Application page and elsewhere. The dashboard's main stat wants just
 * the headline word/phrase - the room/reason detail already lives in
 * the meta line right below it (see els.appMeta below), so showing it
 * twice here would be redundant. Keyed by allocation_state so this
 * never depends on parsing the longer label's text.
 */
const APP_STATUS_SHORT_LABELS = {
  no_application: 'No Active Application',
  pending: 'Pending',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  awaiting_allocation: 'Approved',
  allocated: 'Allocated',
  revoked: 'Allocation Revoked',
};

function renderDashboard(data, els) {
  const { application, room, payment } = data;

  // --- Application status card ---
  // Dashboard shows only the short headline (see APP_STATUS_SHORT_LABELS
  // above); the My Application page and admin views still use the full
  // allocation_state_label untouched.
  const appStatusLabel = application
    ? (APP_STATUS_SHORT_LABELS[application.allocation_state] || capitalize(application.status))
    : APP_STATUS_SHORT_LABELS.no_application;
  const appBadgeClass = application ? (application.allocation_state || application.status) : 'none';
  setStat(els.appStatus, appStatusLabel, appBadgeClass);

  if (!application) {
    els.appMeta.textContent = "You haven't submitted a hostel application yet.";
  } else if (application.status === 'rejected') {
    els.appMeta.textContent = application.rejection_reason
      ? `Reason: ${application.rejection_reason}`
      : 'No reason was provided.';
  } else if (application.allocation_state === 'revoked') {
    els.appMeta.textContent = 'Your room allocation was revoked. You may reapply for a room.';
  } else {
    els.appMeta.textContent = `Applied ${formatDate(application.applied_at, false)} · ${capitalize(application.room_type)} room`;
  }

  // --- Room status card ---
  if (room) {
    setStat(els.roomStatus, room.room_number, 'approved');
    els.roomMeta.textContent = `${room.block_name} · ${capitalize(room.room_type)}`;
  } else {
    setStat(els.roomStatus, 'Not Allocated', 'none');
    if (application && application.allocation_state === 'revoked') {
      els.roomMeta.textContent = 'Your previous room allocation was revoked.';
    } else {
      els.roomMeta.textContent = application
        ? 'A room is assigned once your application is approved.'
        : 'Apply for a room to get started.';
    }
  }

  // --- Payment status card ---
  if (payment) {
    const label = capitalize(payment.status);
    setStat(els.payStatus, label, payment.status);
    els.payMeta.textContent =
      payment.status === 'paid'
        ? `Paid ${formatDate(payment.paid_at, false)}`
        : payment.status === 'unpaid'
          ? unpaidPaymentNote(application)
          : `Reference: ${payment.reference || '—'}`;
  } else {
    setStat(els.payStatus, 'Unpaid', 'none');
    els.payMeta.textContent = 'Payment opens once your application is approved.';
  }

  // --- Call to action ---
  if (els.ctaBox) {
    els.ctaBox.innerHTML = buildCta(application);
  }
}

// PAYMENT-BEFORE-ALLOCATION wording. payment_stage is computed by the server (the browser
// only displays it): approve -> fee block confirmed -> pay -> room allocated.
function unpaidPaymentNote(application) {
  const stage = application && application.payment_stage;
  if (stage === 'awaiting_fee_block') return 'Payment opens once the hostel confirms your fee block.';
  if (stage === 'payment_required' || stage === 'allocated_unpaid') return 'Your hostel fee is due.';
  return 'Payment opens once your application is approved.';
}

function buildCta(application) {
  if (!application) {
    return `
      <p>You have not applied for hostel accommodation yet.</p>
      <a class="btn btn-primary" href="/student/apply-room.html">Apply for a room</a>
    `;
  }
  if (application.status === 'pending') {
    return `<p>Your application is being reviewed. You'll see a decision here as soon as it's ready.</p>
            <a class="btn btn-secondary" href="/student/application.html">View application</a>`;
  }
  // 'approved' branches on allocation_state, since an approved
  // application can be allocated, awaiting allocation, or revoked
  // - three different situations that each need a different CTA.
  if (application.status === 'approved' && application.allocation_state === 'revoked') {
    return `<p>Your previous room allocation was revoked. You may reapply for a room.</p>
            <a class="btn btn-primary" href="/student/apply-room.html">Reapply for a room</a>`;
  }
  switch (application.payment_stage) {
    case 'awaiting_fee_block':
      return `<p>Your application has been approved. The hostel administration is confirming your fee block; you can pay as soon as it is confirmed.</p>
              <a class="btn btn-secondary" href="/student/application.html">View application</a>`;
    case 'payment_required':
      return `<p>Your application has been approved. Pay your hostel fee next; a room is allocated after your payment is verified. Payment does not guarantee a room until allocation succeeds.</p>
              <a class="btn btn-primary" href="/student/payment.html">Go to payment</a>`;
    case 'payment_pending':
      return `<p>Your payment is still being confirmed. A room can be allocated after it is verified.</p>
              <a class="btn btn-primary" href="/student/payment.html">Check payment</a>`;
    case 'paid_awaiting_room':
      return `<p>Your hostel fee is paid. The hostel administration will allocate your room.</p>
              <a class="btn btn-secondary" href="/student/application.html">View application</a>`;
    case 'allocated_paid':
      return `<p>Your room has been allocated and your hostel fee is paid.</p>
              <a class="btn btn-secondary" href="/student/application.html">View application</a>`;
    default:
      break; // allocated_unpaid and anything else fall through to the original messages below
  }
  if (application.status === 'approved' && application.allocation_state === 'awaiting_allocation') {
    return `<p>Your application has been approved. A room will be allocated soon.</p>
            <a class="btn btn-secondary" href="/student/application.html">View application</a>`;
  }
  if (application.status === 'approved') {
    return `<p>Your room has been allocated. Complete your payment to secure your space.</p>
            <a class="btn btn-primary" href="/student/payment.html">Go to payment</a>`;
  }
  if (application.status === 'rejected') {
    return `<p>Your previous application was not successful. You're welcome to apply again.</p>
            <a class="btn btn-primary" href="/student/apply-room.html">Apply again</a>`;
  }
  return '';
}

function setStat(el, text, badgeClass) {
  if (!el) return;
  el.textContent = text;
  el.className = `stat-card-value badge badge-${badgeClass}`;
}

function capitalize(value) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/* ---------------------------------------------------------------------
   Profile (student/profile.html)
   --------------------------------------------------------------------- */
async function initProfilePage() {
  const form = document.getElementById('profile-form');
  if (!form) return;

  const alertBox = document.getElementById('form-alert');
  const submitBtn = form.querySelector('button[type="submit"]');

  try {
    const profile = await api.get('/students/profile');
    fillProfileReadOnly(profile);
    form.full_name.value = profile.full_name || '';
    form.email.value = profile.email || '';
    form.phone.value = profile.phone || '';
    form.department.value = profile.department || '';
    form.level.value = profile.level || '';
    form.student_id.value = profile.student_id || '';
    form.gender.value = profile.gender || '';
  } catch (error) {
    showAlert(alertBox, error.message, 'error');
    return;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAlert(alertBox);

    const payload = {
      full_name: form.full_name.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim(),
      department: form.department.value.trim(),
      level: form.level.value.trim(),
      student_id: form.student_id.value.trim(),
      gender: form.gender.value,
    };

    const restore = setButtonLoading(submitBtn, 'Saving…');
    try {
      await api.put('/students/profile', payload);
      showAlert(alertBox, 'Profile updated successfully.', 'success');
      const nameEl = document.getElementById('topbar-user-name');
      const avatarEl = document.getElementById('topbar-avatar');
      if (nameEl) nameEl.textContent = payload.full_name;
      if (avatarEl) avatarEl.textContent = initials(payload.full_name);
    } catch (error) {
      // The gender-guard conflict from the backend ("cannot be changed
      // because you have an approved application...") is a 409 with no
      // field-level detail attached - applyFieldErrors has nothing to
      // highlight, so the message alone (via showAlert below) is what
      // carries it. Field errors from express-validator still highlight
      // the specific input when there are any.
      if (error.errors && error.errors.length) applyFieldErrors(form, error.errors);
      showAlert(alertBox, error.message, 'error');
    } finally {
      restore();
    }
  });

  initDeactivateForm();
}

function fillProfileReadOnly(profile) {
  const sinceEl = document.getElementById('ro-since');
  if (sinceEl) sinceEl.textContent = formatDate(profile.created_at, false);
}

/**
 * The "Danger zone" deactivation form. Two deliberate friction steps
 * before anything happens, matching the brief's requirement that a
 * single casual click cannot deactivate an account: the student must
 * type their current password (verified server-side via bcrypt before
 * any write - see studentController.deactivateAccount), AND confirm a
 * native browser dialog. Neither step alone would be enough on its own
 * to call this "not accidental" - together they are.
 */
function initDeactivateForm() {
  const form = document.getElementById('deactivate-form');
  if (!form) return;

  const alertBox = document.getElementById('deactivate-alert');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAlert(alertBox);

    const confirmed = window.confirm(
      'This will deactivate your account and sign you out immediately. ' +
      'You will not be able to log back in. Continue?'
    );
    if (!confirmed) return;

    const restore = setButtonLoading(submitBtn, 'Deactivating…');
    try {
      await api.del('/students/profile', { body: { password: form.password.value } });
      window.location.href = '/login.html';
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
      restore();
    }
  });
}
