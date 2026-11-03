/**
 * js/rooms.js
 * ---------------------------------------------------------------
 * Room availability management. Gated by #rooms-root, same
 * element-presence pattern as every other page-specific script.
 *
 * This is a separate file from admin.js, not because it couldn't
 * technically be added there, but because that's the convention this
 * project already established: admin.js (like student.js) is the
 * shell plus its primary page; a distinct feature area gets its own
 * file (application.js does this for the student side).
 * admin.js's own DOMContentLoaded handler still runs guardAdminPage(),
 * the sidebar, and logout - this file only adds room-specific logic
 * on top, exactly like application.js layers onto student.js.
 * ---------------------------------------------------------------
 */

document.addEventListener('DOMContentLoaded', () => {
  initRoomsPage();
});

async function initRoomsPage() {
  const root = document.getElementById('rooms-root');
  if (!root) return;

  const tableBody = document.getElementById('rooms-table-body');
  const emptyState = document.getElementById('rooms-empty');
  const errorBox = document.getElementById('rooms-error');
  const filterForm = document.getElementById('rooms-filter-form');

  // Rooms already on the page are reused to populate the block filter
  // dropdown (deduplicated client-side) rather than adding a second
  // endpoint just to list blocks - the same approach apply-room.html
  // uses for its own block dropdown.
  let blockFilterPopulated = false;

  async function loadRooms() {
    clearAlert(errorBox);
    emptyState.classList.add('is-hidden');
    tableBody.innerHTML = `<tr><td colspan="9"><span class="spinner"></span> Loading rooms…</td></tr>`;

    const params = new URLSearchParams();
    if (filterForm.block_id.value) params.set('block_id', filterForm.block_id.value);
    if (filterForm.gender.value) params.set('gender', filterForm.gender.value);
    if (filterForm.room_type.value) params.set('room_type', filterForm.room_type.value);
    if (filterForm.occupancy_status.value) params.set('occupancy_status', filterForm.occupancy_status.value);

    try {
      const rooms = await api.get(`/admin/rooms?${params.toString()}`);
      if (!blockFilterPopulated) {
        populateBlockFilter(rooms);
        blockFilterPopulated = true;
      }
      renderTable(rooms);
    } catch (error) {
      tableBody.innerHTML = '';
      showAlert(errorBox, error.message, 'error');
    }
  }

  function populateBlockFilter(rooms) {
    const select = filterForm.block_id;
    const seen = new Set();
    for (const room of rooms) {
      if (seen.has(room.block.id)) continue;
      seen.add(room.block.id);
      const option = document.createElement('option');
      option.value = room.block.id;
      option.textContent = room.block.name;
      select.appendChild(option);
    }
  }

  // A single, unambiguous status per room. Deactivated rooms show ONLY
  // "Inactive" - not "Full" and "Inactive" both at once. Reuses the
  // badge-vacant/partial/full/none CSS classes (defined in global.css);
  // is_active takes priority over the occupancy state.
  const OCCUPANCY_LABELS = { vacant: 'Vacant', partial: 'Partially Occupied', full: 'Full' };

  function statusBadge(room) {
    if (!room.is_active) {
      return '<span class="badge badge-none">Inactive</span>';
    }
    const label = OCCUPANCY_LABELS[room.occupancy_status] || capitalize(room.occupancy_status);
    return `<span class="badge badge-${room.occupancy_status}">${label}</span>`;
  }

  function renderTable(rooms) {
    if (rooms.length === 0) {
      tableBody.innerHTML = '';
      emptyState.classList.remove('is-hidden');
      return;
    }

    tableBody.innerHTML = rooms.map((room) => `
      <tr data-room-id="${room.id}">
        <td>${escapeHtml(room.block.name)}</td>
        <td class="nowrap">${capitalize(room.gender)}</td>
        <td class="nowrap">${escapeHtml(room.room_number)}</td>
        <td class="nowrap">${capitalize(room.room_type)}</td>
        <td class="num nowrap">${room.capacity}</td>
        <td class="num nowrap">${room.occupied_spaces}</td>
        <td class="num nowrap">${room.available_spaces}</td>
        <td class="nowrap">${statusBadge(room)}</td>
        <td class="table-actions nowrap">
          <button class="btn btn-secondary btn-sm" data-edit-id="${room.id}">Manage</button>
        </td>
      </tr>
    `).join('');

    tableBody.querySelectorAll('[data-edit-id]').forEach((btn) => {
      const room = rooms.find((r) => String(r.id) === btn.dataset.editId);
      btn.addEventListener('click', () => openManagePanel(room));
    });
  }

  function openManagePanel(room) {
    const panel = document.getElementById('room-manage-panel');
    panel.classList.remove('is-hidden');
    panel.innerHTML = `
      <div class="panel-header">
        <h3>${escapeHtml(room.room_number)} — ${escapeHtml(room.block.name)} (${capitalize(room.gender)})</h3>
        <button class="btn btn-ghost btn-sm" id="close-manage-panel" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>

      <div class="info-row">
        <span class="info-row-label">Room type</span>
        <span class="info-row-value">${capitalize(room.room_type)}</span>
      </div>
      <div class="info-row">
        <span class="info-row-label">Currently occupied</span>
        <span class="info-row-value">${room.occupied_spaces} of ${room.capacity}</span>
      </div>

      <div class="field" style="margin-top: var(--sp-4)">
        <label for="capacity-input">Capacity</label>
        <input type="number" id="capacity-input" min="1" max="12" value="${room.capacity}"
          ${room.room_type === 'single' ? 'disabled' : ''} />
        ${room.room_type === 'single'
          ? '<p class="field-help">Single rooms always have a capacity of 1 and cannot be changed.</p>'
          : `<p class="field-help">Cannot be set below ${room.occupied_spaces} (students already allocated here).</p>`}
      </div>

      <div class="field">
        <label for="active-toggle">Room status</label>
        <select id="active-toggle">
          <option value="true" ${room.is_active ? 'selected' : ''}>Active - available for allocation</option>
          <option value="false" ${!room.is_active ? 'selected' : ''}>Inactive - hidden from new allocations</option>
        </select>
        <p class="field-help">Deactivating does not remove students already living here.</p>
      </div>

      <div class="alert" id="manage-alert" style="margin-top: var(--sp-3)"></div>
      <button class="btn btn-primary" id="save-room-btn">Save changes</button>
    `;

    document.getElementById('close-manage-panel').addEventListener('click', () => {
      panel.classList.add('is-hidden');
      panel.innerHTML = '';
    });

    document.getElementById('save-room-btn').addEventListener('click', () => saveRoom(room));
  }

  async function saveRoom(room) {
    const alertBox = document.getElementById('manage-alert');
    const btn = document.getElementById('save-room-btn');
    const capacityInput = document.getElementById('capacity-input');
    const activeSelect = document.getElementById('active-toggle');

    const payload = { is_active: activeSelect.value === 'true' };
    // Single-room capacity input is disabled and never sent - the
    // value is fixed at 1 by the database trigger regardless.
    if (room.room_type !== 'single') {
      payload.capacity = Number(capacityInput.value);
    }

    const restore = setButtonLoading(btn, 'Saving…');
    try {
      await api.put(`/admin/rooms/${room.id}`, payload);
      document.getElementById('room-manage-panel').classList.add('is-hidden');
      await loadRooms();
    } catch (error) {
      showAlert(alertBox, error.message, 'error');
      restore();
    }
  }

  filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loadRooms();
  });
  filterForm.addEventListener('reset', () => {
    setTimeout(loadRooms, 0);
  });

  loadRooms();
}

// capitalize() is defined in js/admin.js, loaded on every /admin/ page
// before this file - not redefined here to avoid two competing copies.
