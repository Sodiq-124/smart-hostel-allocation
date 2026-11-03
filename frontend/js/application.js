/**
 * js/application.js
 * ---------------------------------------------------------------
 * Two page-specific behaviours, gated by element presence the same
 * way auth.js and student.js are - a page with neither container
 * simply does nothing here.
 *
 *   apply-room.html  -> #apply-room-root
 *   application.html -> #application-root
 *
 * This file assumes js/student.js has already run guardStudentPage()
 * on DOMContentLoaded (both scripts listen for the same event; script
 * tag order in the HTML determines which handler attaches first, and
 * since both only touch elements that already exist in the markup,
 * order between this file and student.js does not matter here).
 * ---------------------------------------------------------------
 */

document.addEventListener('DOMContentLoaded', () => {
  initApplyRoomPage();
  initApplicationPage();
});

/* ---------------------------------------------------------------------
   Apply for Room (student/apply-room.html)
   --------------------------------------------------------------------- */
async function initApplyRoomPage() {
  const root = document.getElementById('apply-room-root');
  if (!root) return;

  const alertBox = document.getElementById('form-alert');
  const formSection = document.getElementById('apply-room-form-section');
  const existingSection = document.getElementById('apply-room-existing');

  // If the student already has a live application, submitting a new
  // one would just fail on the server's uq_active_application unique
  // index (see database/hostel.sql). Checking first means they see a
  // clear explanation instead of filling out a form only to hit an
  // error at the end.
  let existing;
  try {
    existing = await api.get('/applications/my');
  } catch (error) {
    showAlert(alertBox, error.message, 'error');
    return;
  }

  // A revoked application (allocation_state === 'revoked') does not
  // block reapplying - the backend's allocationService.createApplication()
  // supersedes it automatically on submit. A pending application, and an
  // approved application that is allocated or still awaiting its first
  // allocation, do block.
  const isBlocking = existing
    && (existing.status === 'pending'
      || (existing.status === 'approved' && existing.allocation_state !== 'revoked'));

  if (isBlocking) {
    formSection.classList.add('is-hidden');
    existingSection.classList.remove('is-hidden');
    existingSection.innerHTML = `
      <div class="alert alert-info">
        You already have ${existing.status === 'pending' ? 'a pending' : 'an approved'} hostel application.
        You can't submit another until it is decided.
      </div>
      <a class="btn btn-primary" href="/student/application.html">View my application</a>
    `;
    return;
  }

  if (existing && existing.allocation_state === 'revoked') {
    showAlert(
      alertBox,
      'Your previous room allocation was revoked. Submitting a new application below will replace it.',
      'info'
    );
  }

  let roomOptions;
  try {
    roomOptions = await api.get('/applications/room-options');
  } catch (error) {
    showAlert(alertBox, error.message, 'error');
    return;
  }

  const form = document.getElementById('apply-room-form');
  populateBlockOptions(form, roomOptions.blocks);
  wireAvailabilityHint(form, roomOptions);
  wireApplyRoomForm(form, alertBox);
}

function populateBlockOptions(form, blocks) {
  const select = form.preferred_block_id;
  const seen = new Set();

  for (const row of blocks) {
    if (seen.has(row.block_id)) continue;
    seen.add(row.block_id);
    const option = document.createElement('option');
    option.value = row.block_id;
    option.textContent = row.block_name;
    select.appendChild(option);
  }

  if (blocks.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'No blocks currently available';
    option.disabled = true;
    select.appendChild(option);
  }
}

/**
 * Updates the availability line under the two selects using the data
 * already fetched in initApplyRoomPage - no extra request is made each
 * time the student changes a dropdown.
 */
function wireAvailabilityHint(form, roomOptions) {
  const hintEl = document.getElementById('availability-hint');

  function update() {
    const roomType = form.room_type.value;
    const blockId = form.preferred_block_id.value;

    if (!roomType) {
      hintEl.className = 'availability-hint';
      hintEl.textContent = 'Choose a room type to see current availability.';
      return;
    }

    let spaces;
    let scopeLabel;

    if (blockId) {
      const match = roomOptions.blocks.find(
        (r) => String(r.block_id) === blockId && r.room_type === roomType
      );
      spaces = match ? Number(match.total_available_spaces) : 0;
      scopeLabel = form.preferred_block_id.selectedOptions[0]?.textContent || 'this block';
    } else {
      const overall = roomOptions.overallByType[roomType];
      spaces = overall ? Number(overall.total_available_spaces) : 0;
      scopeLabel = 'across all blocks';
    }

    const hasSpace = spaces > 0;
    hintEl.className = `availability-hint ${hasSpace ? 'has-space' : 'no-space'}`;
    hintEl.innerHTML = hasSpace
      ? `<i class="fa-solid fa-circle-check"></i> ${spaces} space${spaces === 1 ? '' : 's'} currently available for ${capitalize(roomType)} rooms ${scopeLabel}.`
      : `<i class="fa-solid fa-circle-exclamation"></i> No ${roomType} rooms are currently available ${scopeLabel}.`;
  }

  // form.room_type is now a RadioNodeList (two <input type="radio">
  // sharing the name "room_type"), not a single element - reading
  // .value still works (RadioNodeList.value is spec-defined to return
  // the checked radio's value), but RadioNodeList has no
  // addEventListener of its own, since it's a NodeList, not a single
  // EventTarget. Delegating from the form itself avoids attaching a
  // listener to each radio individually and keeps working regardless
  // of how many options a pill-group ends up with.
  form.addEventListener('change', (event) => {
    if (event.target.name === 'room_type') update();
  });
  form.preferred_block_id.addEventListener('change', update);
  update();
}

function wireApplyRoomForm(form, alertBox) {
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAlert(alertBox);

    const payload = {
      room_type: form.room_type.value,
      preferred_block_id: form.preferred_block_id.value || null,
      special_request: form.special_request.value.trim(),
    };

    const restore = setButtonLoading(submitBtn, 'Submitting…');
    try {
      await api.post('/applications', payload);
      showAlert(
        alertBox,
        'Application submitted successfully. Your application is currently pending admin review.',
        'success'
      );
      setTimeout(() => { window.location.href = '/student/application.html'; }, 1200);
    } catch (error) {
      if (error.errors && error.errors.length) applyFieldErrors(form, error.errors);
      showAlert(alertBox, error.message, 'error');
    } finally {
      restore();
    }
  });
}

/* ---------------------------------------------------------------------
   My Application (student/application.html)
   --------------------------------------------------------------------- */
async function initApplicationPage() {
  const root = document.getElementById('application-root');
  if (!root) return;

  try {
    const application = await api.get('/applications/my');
    renderApplication(root, application);
  } catch (error) {
    root.innerHTML = `<div class="alert alert-error">${escapeHtml(error.message)}</div>`;
  }
}

function renderApplication(root, application) {
  if (!application) {
    root.innerHTML = `
      <div class="panel empty-state">
        <h3>No application yet</h3>
        <p>You haven't submitted a hostel application yet.</p>
        <a class="btn btn-primary" href="/student/apply-room.html">Apply for a room</a>
      </div>
    `;
    return;
  }

  // Prefer the server-resolved allocation_state_label - it
  // distinguishes "Approved - Awaiting Allocation" from "Allocation
  // Revoked - You may reapply" (both are status = 'approved' otherwise).
  // Falls back to the raw status for any older/other application shape.
  const badgeClass = application.allocation_state || application.status;
  const badgeText = application.allocation_state_label || capitalize(application.status);
  const statusBadge = `<span class="badge badge-${badgeClass}">${escapeHtml(badgeText)}</span>`;

  let extraRows = '';
  if (application.status === 'rejected') {
    extraRows += `
      <div class="info-row">
        <span class="info-row-label">Reason</span>
        <span class="info-row-value">${escapeHtml(application.rejection_reason || 'No reason provided.')}</span>
      </div>`;
  }
  if (application.status === 'approved' && application.allocated_room_number) {
    extraRows += `
      <div class="info-row">
        <span class="info-row-label">Allocated room</span>
        <span class="info-row-value">${escapeHtml(application.allocated_room_number)} (${escapeHtml(application.allocated_block_name)})</span>
      </div>`;
  }
  if (application.allocation_state === 'revoked') {
    extraRows += `
      <div class="info-row">
        <span class="info-row-label">Allocated room</span>
        <span class="info-row-value">Revoked — you may reapply for a room.</span>
      </div>`;
  }

  const withdrawButton = application.status === 'pending'
    ? `<button class="btn btn-danger" id="withdraw-btn" style="margin-top: var(--sp-4)">Withdraw application</button>`
    : '';

  root.innerHTML = `
    <div class="panel">
      <div class="panel-header">
        <h3>Application #${application.id}</h3>
        ${statusBadge}
      </div>

      <div class="info-row">
        <span class="info-row-label">Room type</span>
        <span class="info-row-value">${capitalize(application.room_type)}</span>
      </div>
      <div class="info-row">
        <span class="info-row-label">Preferred block</span>
        <span class="info-row-value">${escapeHtml(application.preferred_block_name || 'No preference')}</span>
      </div>
      <div class="info-row">
        <span class="info-row-label">Special request</span>
        <span class="info-row-value">${escapeHtml(application.special_request || '—')}</span>
      </div>
      <div class="info-row">
        <span class="info-row-label">Date applied</span>
        <span class="info-row-value">${formatDate(application.applied_at)}</span>
      </div>
      <div class="info-row">
        <span class="info-row-label">Last updated</span>
        <span class="info-row-value">${formatDate(application.reviewed_at || application.applied_at)}</span>
      </div>
      ${extraRows}

      ${withdrawButton}
      <div class="alert" id="withdraw-alert" style="margin-top: var(--sp-4)"></div>
    </div>
  `;

  const withdrawBtn = document.getElementById('withdraw-btn');
  if (withdrawBtn) {
    withdrawBtn.addEventListener('click', () => handleWithdraw(application.id, withdrawBtn));
  }
}

async function handleWithdraw(applicationId, button) {
  const alertBox = document.getElementById('withdraw-alert');
  const confirmed = window.confirm(
    'Withdraw this application? You will need to apply again if you change your mind.'
  );
  if (!confirmed) return;

  const restore = setButtonLoading(button, 'Withdrawing…');
  try {
    await api.put(`/applications/${applicationId}/cancel`);
    window.location.reload();
  } catch (error) {
    showAlert(alertBox, error.message, 'error');
    restore();
  }
}

// capitalize() is defined in js/student.js, loaded on every /student/
// page before this file - not redefined here to avoid two competing
// copies of the same small helper.
