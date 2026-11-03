/**
 * tests/phase10_cancel_revoke_unit.js - admin cancel / revoke workflows
 *
 * Covers allocationService.cancelApprovedApplication() and revokeAllocation() against an
 * in-memory fake that emulates the SQL they issue, including ROLLBACK on error. Proves the
 * LOGIC (history kept, occupancy never double-decremented, inconsistent data refused, atomic).
 * It does NOT prove the SQL is valid MariaDB. No database; no network.
 *
 *   node tests/phase10_cancel_revoke_unit.js
 */
const path = require('path');
const dbPath = require.resolve(path.join(__dirname, '..', 'config', 'database'));
let S;
const fresh = () => ({
  rooms: { 24: { id: 24, occupied_spaces: 1 }, 25: { id: 25, occupied_spaces: 0 } },
  applications: [
    { id: 1, student_id: 7, status: 'approved', allocated_room_id: 24 },   // approved + allocated
    { id: 2, student_id: 8, status: 'approved', allocated_room_id: null }, // approved, not yet allocated
    { id: 3, student_id: 9, status: 'pending', allocated_room_id: null },
    { id: 4, student_id: 10, status: 'cancelled', allocated_room_id: null },
    { id: 5, student_id: 11, status: 'approved', allocated_room_id: 25 },  // inconsistent: no allocation record
  ],
  allocations: [{ id: 50, application_id: 1, student_id: 7, room_id: 24, status: 'active' }],
  payments: [{ id: 9, application_id: 1, status: 'success' }],
});
function exec(sqlRaw, p = []) {
  const sql = sqlRaw.replace(/\s+/g, ' ').trim();
  if (/^SELECT id, student_id, status, allocated_room_id FROM applications WHERE id = \? FOR UPDATE/.test(sql) || /^SELECT id, status, allocated_room_id FROM applications WHERE id = \? FOR UPDATE/.test(sql)) return [S.applications.filter((a) => a.id === Number(p[0])).map((a) => ({ ...a }))];
  if (/^SELECT id, room_id FROM allocations WHERE application_id = \? AND status = 'active' FOR UPDATE/.test(sql)) return [S.allocations.filter((a) => a.application_id === Number(p[0]) && a.status === 'active').map((a) => ({ id: a.id, room_id: a.room_id }))];
  if (/^SELECT id, occupied_spaces FROM rooms WHERE id = \? FOR UPDATE/.test(sql)) { const r = S.rooms[p[0]]; return [r ? [{ ...r }] : []]; }
  if (/^UPDATE rooms SET occupied_spaces = occupied_spaces - 1 WHERE id = \? AND occupied_spaces > 0/.test(sql)) { const r = S.rooms[p[0]]; if (!r || r.occupied_spaces < 1) return [{ affectedRows: 0 }]; r.occupied_spaces -= 1; return [{ affectedRows: 1 }]; }
  if (/^UPDATE allocations SET status = 'released', released_at = NOW\(\), release_reason = \? WHERE id = \? AND status = 'active'/.test(sql)) { const a = S.allocations.find((x) => x.id === p[1] && x.status === 'active'); if (!a) return [{ affectedRows: 0 }]; a.status = 'released'; a.release_reason = p[0]; return [{ affectedRows: 1 }]; }
  if (/^UPDATE applications SET allocated_room_id = NULL WHERE id = \? AND allocated_room_id = \?/.test(sql)) { const a = S.applications.find((x) => x.id === Number(p[0]) && x.allocated_room_id === p[1]); if (!a) return [{ affectedRows: 0 }]; a.allocated_room_id = null; return [{ affectedRows: 1 }]; }
  if (/^UPDATE applications SET status = 'cancelled', allocated_room_id = NULL, rejection_reason = \?, reviewed_by = \?, reviewed_at = NOW\(\) WHERE id = \? AND status = 'approved'/.test(sql)) { const a = S.applications.find((x) => x.id === Number(p[2]) && x.status === 'approved'); if (!a) return [{ affectedRows: 0 }]; Object.assign(a, { status: 'cancelled', allocated_room_id: null, rejection_reason: p[0], reviewed_by: p[1] }); return [{ affectedRows: 1 }]; }
  throw new Error(`UNMODELLED SQL: ${sql}`);
}
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { withTransaction: async (cb) => { const snap = JSON.stringify(S); try { return await cb({ execute: async (q, p) => exec(q, p) }); } catch (e) { S = JSON.parse(snap); throw e; } } } };
const svc = require('../services/allocationService');

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else { fail += 1; console.log(`  FAIL ${n}${d !== undefined ? ` :: ${d}` : ''}`); } };
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

(async () => {
  /* ---- cancelApprovedApplication ---- */
  S = fresh();
  let r = await svc.cancelApprovedApplication({ applicationId: 1, reason: 'Student withdrew', adminId: 1 });
  check('H1  cancel an allocated approved application succeeds and reports the release', r.application_id === 1 && r.allocation_released === true);
  check('H2  application is cancelled, room link cleared, reviewer recorded, reason audited', S.applications[0].status === 'cancelled' && S.applications[0].allocated_room_id === null && S.applications[0].reviewed_by === 1 && S.applications[0].rejection_reason === 'Admin cancellation: Student withdrew');
  check('H3  the allocation is RETAINED as history (released, never deleted) with a reason', S.allocations.length === 1 && S.allocations[0].status === 'released' && /Admin cancellation/.test(S.allocations[0].release_reason));
  check('H4  room occupancy decreased by exactly one', S.rooms[24].occupied_spaces === 0);
  check('H5  the payment record is untouched', S.payments.length === 1 && S.payments[0].status === 'success');
  let e = await err(svc.cancelApprovedApplication({ applicationId: 1, reason: 'again', adminId: 1 }));
  check('H6  cancelling twice -> 409 (already cancelled)', e && e.statusCode === 409 && /cancelled/.test(e.message));
  check('H7  the double cancel did NOT decrement occupancy again', S.rooms[24].occupied_spaces === 0);

  S = fresh();
  r = await svc.cancelApprovedApplication({ applicationId: 2, reason: 'No longer needed', adminId: 1 });
  check('H8  cancel an approved application with NO room: allocation_released=false, nothing else touched', r.allocation_released === false && S.applications[1].status === 'cancelled' && S.rooms[24].occupied_spaces === 1 && S.allocations[0].status === 'active');

  S = fresh();
  e = await err(svc.cancelApprovedApplication({ applicationId: 3, reason: 'x', adminId: 1 }));
  check('H9  a PENDING application cannot be cancelled this way (409)', e && e.statusCode === 409 && S.applications[2].status === 'pending');
  e = await err(svc.cancelApprovedApplication({ applicationId: 4, reason: 'x', adminId: 1 }));
  check('H10 an already-cancelled application -> 409', e && e.statusCode === 409);
  e = await err(svc.cancelApprovedApplication({ applicationId: 999, reason: 'x', adminId: 1 }));
  check('H11 unknown application -> 404', e && e.statusCode === 404);
  e = await err(svc.cancelApprovedApplication({ applicationId: 5, reason: 'x', adminId: 1 }));
  check('H12 application points at a room but has no active allocation -> 409 "inconsistent", nothing changed', e && e.statusCode === 409 && /inconsistent/.test(e.message) && S.applications[4].status === 'approved' && S.rooms[25].occupied_spaces === 0);

  S = fresh(); S.rooms[24].occupied_spaces = 0; // occupancy already 0 although an allocation is active
  e = await err(svc.cancelApprovedApplication({ applicationId: 1, reason: 'x', adminId: 1 }));
  check('H13 room occupancy already 0 -> 409 and the allocation stays ACTIVE (no half-done cancel)', e && e.statusCode === 409 && S.allocations[0].status === 'active' && S.applications[0].status === 'approved');

  S = fresh(); S.allocations[0].room_id = 25; // allocation row disagrees with application.allocated_room_id
  e = await err(svc.cancelApprovedApplication({ applicationId: 1, reason: 'x', adminId: 1 }));
  check('H14 allocation room differs from the application\'s room -> 409, nothing changed', e && e.statusCode === 409 && S.rooms[24].occupied_spaces === 1 && S.rooms[25].occupied_spaces === 0 && S.allocations[0].status === 'active');

  /* ---- revokeAllocation ---- */
  S = fresh();
  r = await svc.revokeAllocation({ applicationId: 1, reason: 'Room needed for repairs', adminId: 1 });
  check('R1  revoke succeeds and reports the room and admin', r.application_id === 1 && r.room_id === 24 && r.revoked_by === 1);
  check('R2  after revoke: allocation released (kept), room link cleared, occupancy -1', S.allocations[0].status === 'released' && S.allocations[0].release_reason === 'Room needed for repairs' && S.applications[0].allocated_room_id === null && S.rooms[24].occupied_spaces === 0);
  check('R3  the application stays APPROVED so the student can be re-allocated (revoke is not cancel)', S.applications[0].status === 'approved');
  e = await err(svc.revokeAllocation({ applicationId: 1, reason: 'again', adminId: 1 }));
  check('R4  revoking again -> 409 "no active room allocation", occupancy not decremented twice', e && e.statusCode === 409 && S.rooms[24].occupied_spaces === 0);
  S = fresh();
  e = await err(svc.revokeAllocation({ applicationId: 999, reason: 'x', adminId: 1 }));
  check('R5  unknown application -> 404', e && e.statusCode === 404);
  e = await err(svc.revokeAllocation({ applicationId: 2, reason: 'x', adminId: 1 }));
  check('R6  application with no room -> 409', e && e.statusCode === 409 && /no active room allocation/i.test(e.message));
  e = await err(svc.revokeAllocation({ applicationId: 5, reason: 'x', adminId: 1 }));
  check('R7  room link without an allocation record -> 409, occupancy of that room unchanged', e && e.statusCode === 409 && S.rooms[25].occupied_spaces === 0);
  S = fresh(); S.rooms[24].occupied_spaces = 0;
  e = await err(svc.revokeAllocation({ applicationId: 1, reason: 'x', adminId: 1 }));
  check('R8  occupancy already 0 -> 409 and allocation stays active', e && e.statusCode === 409 && S.allocations[0].status === 'active' && S.applications[0].allocated_room_id === 24);

  console.log(`phase10_cancel_revoke_unit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((x) => { console.log(x.stack); process.exit(2); });
