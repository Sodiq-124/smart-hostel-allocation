# Phase 9C - Miscellaneous charge payments

No migration is required. Phase 9C uses only the schema from migrations 014, 017/020 and 021
(`hostel_misc_charges.deadline_at/late_fine_amount`, `payments.payment_type/hostel_misc_charge_id/original_amount/late_fine_applied`,
nullable `payments.hostel_fee_id`, `uq_successful_misc_payment`). The new code refuses with 503 if those columns are missing.

## Endpoints
Admin (`requireRole('admin')`): `GET /api/admin/misc-charges[?session_id=]`, `GET .../options`, `GET .../:id`, `POST`, `PUT .../:id`,
`POST .../:id/activate`, `POST .../:id/deactivate`. There is no delete.
Student (`requireRole('student')`): `GET /api/payments/misc-charges`, `POST /api/payments/misc-charges/:chargeId/initialize`,
`GET /api/payments/history`. Verification/webhook reuse `POST /api/payments/verify` and `POST /api/payments/webhook`.

## Rules
- Amount = charge.amount (+ fixed `late_fine_amount` once, if `NOW() > deadline_at` when the payment is started). The instant of the deadline is on time. Computed on the server in kobo; stored as original_amount + late_fine_applied = amount.
- Eligibility: approved application in the open session; charge active, same session, block NULL or the student's block (active allocation's block, else confirmed fee block). Otherwise 404.
- Reference: `LASU-MC-<application>-<charge>-<time>-<random>` (hostel stays `LASU-HF-...`). Settlement checks type/reference/charge/application/student/session/original_amount before asking Paystack, then amount + currency against the stored row.
- Duplicates: one successful hostel payment per application+session; one successful misc payment per application+session+charge (database keys). A pending misc payment never blocks the hostel fee and vice versa.
- `paymentGate` only counts `payment_type = 'hostel'`; a misc payment can never open room allocation.
- Once any payment exists for a charge its amount and block are locked. Charges of closed sessions are read-only.

## Documented decisions (not specified before)
- The fine is decided when the payment is started, not when Paystack confirms it.
- A charge past its deadline with fine 0 stays payable (no closing rule exists in the schema).
- "Fine needs a deadline" is enforced in the application because live `ck_misc_charges_fine` only checks fine >= 0.
- Deadlines are compared with the database clock (`NOW()`), i.e. in the database server's time zone.
