# Phase 9E - Hostel fee per academic session

**Finding:** `hostel_fees` already stores one ACTIVE fee per (hostel session, block) (unique key `uq_active_fee`),
`feeService.getBlockFee()` prices an application from its own `hostel_session_id`, and payments point at the fee
row they paid (`payments.hostel_fee_id`). There was no admin way to set fees (SQL only) and no fee shown to students
when applying. No schema change or migration is needed.

**Admin** (`/api/admin/fees`, admin role only; page `admin/fees.html`, sidebar "Hostel Fees")
- `GET /options` sessions + editable flag; `GET /sessions/:sessionId` blocks with current fee, earlier fees, payment counts;
  `PUT /sessions/:sessionId/blocks/:blockId {amount}`.
- Changing a fee never edits an amount: the old row is deactivated (kept) and a new active row inserted, so
  payments keep the exact fee they paid. Only that session+block is touched. Closed/archived sessions are read-only.
- Amounts are validated in integer kobo (`utils/money.js`), NGN, > 0, at most 2 decimals, <= 99,999,999.99.

**Student** `GET /api/fees/current` (student role, read-only): the current open session's active fees for the blocks that
suit the student's gender, shown on `student/apply-room.html`. Display only; charging is still decided by the server.

**Not changed:** feeService, paymentService, paymentGate, allocation/application code, Paystack, `.env`, legacy room-type fee rows.
