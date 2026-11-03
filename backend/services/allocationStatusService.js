/**
 * services/allocationStatusService.js
 * ---------------------------------------------------------------
 * Allocation status + revocation.
 *
 * allocationService.revokeAllocation() deliberately leaves
 * applications.status as 'approved' after a revocation - see that
 * function's own header comment for why (it lets the same approved
 * application be re-allocated a different room without re-approval).
 *
 * That means applications.status alone can no longer answer "what is
 * this application's current allocation state?" - an approved
 * application with allocated_room_id = NULL is now AMBIGUOUS between
 * two different situations:
 *
 *   1. Approved, and never yet allocated a room at all.
 *   2. Approved, WAS allocated a room, and that allocation was
 *      revoked - the student is expected to be re-allocated (or to
 *      submit a fresh application, which supersedes this one).
 *
 * This file resolves that ambiguity by looking at allocation HISTORY
 * (the `allocations` table) rather than by changing `applications.status`
 * itself - status keeps meaning exactly what it already means
 * everywhere else in the codebase (approve/reject, cancel, the
 * uq_active_application index). Nothing here writes to the
 * database; this is read-only derived state for display purposes.
 * ---------------------------------------------------------------
 */

const { queryOne } = require('../config/database');

const STATE_LABELS = {
  no_application: 'No Active Application',
  pending: 'Pending Review',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  awaiting_allocation: 'Approved — Awaiting Allocation',
  revoked: 'Allocation Revoked — You may reapply',
  // 'allocated' has no fixed label here - it is built by the caller
  // from the specific room/block, e.g. "Allocated — Block B, Room R012".
};

/**
 * @param {object|null} application - a row that must include at least
 *   { id, status, allocated_room_id }. When allocated_room_id is set,
 *   also pass allocated_room_number and allocated_block_name so the
 *   'allocated' label can name the room - if they are absent, a
 *   generic 'Allocated' label is used instead of throwing.
 * @returns {Promise<{allocation_state: string, allocation_state_label: string}>}
 */
async function resolveAllocationState(application) {
  if (!application) {
    return { allocation_state: 'no_application', allocation_state_label: STATE_LABELS.no_application };
  }

  if (application.status === 'pending') {
    return { allocation_state: 'pending', allocation_state_label: STATE_LABELS.pending };
  }
  if (application.status === 'rejected') {
    return { allocation_state: 'rejected', allocation_state_label: STATE_LABELS.rejected };
  }
  if (application.status === 'cancelled') {
    return { allocation_state: 'cancelled', allocation_state_label: STATE_LABELS.cancelled };
  }

  // From here, application.status === 'approved'.

  if (application.allocated_room_id) {
    const label = (application.allocated_block_name && application.allocated_room_number)
      ? `Allocated — ${application.allocated_block_name}, Room ${application.allocated_room_number}`
      : 'Allocated';
    return { allocation_state: 'allocated', allocation_state_label: label };
  }

  // Approved, currently unallocated: was there ever a released
  // allocation for THIS application? If so, it was revoked, not
  // "never allocated". Only one extra query, and only for this one
  // ambiguous case.
  const lastAllocation = await queryOne(
    `SELECT status FROM allocations
      WHERE application_id = ?
      ORDER BY allocated_at DESC
      LIMIT 1`,
    [application.id]
  );

  if (lastAllocation && lastAllocation.status === 'released') {
    return { allocation_state: 'revoked', allocation_state_label: STATE_LABELS.revoked };
  }

  return { allocation_state: 'awaiting_allocation', allocation_state_label: STATE_LABELS.awaiting_allocation };
}

module.exports = { resolveAllocationState, STATE_LABELS };
