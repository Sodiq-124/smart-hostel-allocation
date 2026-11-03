# Phase 9D - Renewal and forfeiture foundation

## Rules (no earlier rule existed in the code; these were chosen with the project owner)
* **Eligible to renew**: an ACTIVE allocation in a previous (closed/archived) session, no pending/approved application
  or renewal for the current session, and the renewal deadline (if set) has not passed.
* **Renewal deadline**: `hostel_sessions.renewal_deadline_at` (new, nullable; migration 022). NULL = none: students can
  still request, but nothing is forfeited automatically. Compared with the database clock (`NOW()`).
* **Forfeiture**: a past-session allocation is released exactly once: allocation -> `released` (row kept),
  `rooms.occupied_spaces - 1`, old application's `allocated_room_id` cleared, renewal recorded as `forfeited`.
  `allocations.status` has no `forfeited` value in the live schema, so the release_reason starts with "Forfeited:".
  Allocations of the CURRENT session are never forfeited (use revoke/cancel).

## Workflow
student request -> admin approve (creates APPROVED application for the current session, fee block = block of the held
room; old allocation stays active so the room is held) -> student pays with the existing hostel-fee flow ->
admin "Confirm room" (`fulfill`): payment gate, release old allocation, allocate same/other room, one transaction.
Reject keeps the old allocation until the sweep/manual forfeiture. Students can cancel only a pending request.

## API
Student (`/api/renewals`): `GET /status`, `POST /`, `POST /:id/cancel`.
Admin (`/api/admin/renewals`): `GET /overview`, `PUT /deadline`, `GET /`, `POST /:id/approve|reject|fulfill`,
`GET /forfeitures/preview`, `POST /forfeitures/run`, `POST /forfeitures/allocations/:allocationId` (manual, reason required).

## Sweep
`preview` classifies past-session allocations: **forfeitable** (no live renewal), **kept** (pending/approved renewal),
**superseded** (student also holds a current-session allocation - released only by manual forfeiture, never by the sweep).
`run` needs a deadline that has passed, handles each allocation in its own transaction and is idempotent.

## Database
Run `database/migrations/022_renewal_deadline_and_uniqueness.sql` yourself (adds the deadline column and a unique
`active_key` on `hostel_renewals` = one live renewal per student per session). Requires migration 015 (`hostel_renewals`).
Until it is applied every renewal endpoint answers 503 (fail closed).

## Not changed
`allocationService.js`, `adminApplicationValidator.js`, `adminApplicationController.js`, `routes/adminApplications.js`,
`payment.js`, Paystack code, `.env`. `rollover` renewals (type enum value) are not implemented.
Known gap: the existing `allocateRoom` could still allocate a renewal application elsewhere without releasing the old
room; the preview flags that case as "superseded" for a manual release.
