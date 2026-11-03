/**
 * js/sessionFees.js - the read-only hostel-fee list on student/apply-room.html (#fee-panel).
 * Shows what the SERVER says the current session's fee is for each block. Display only:
 * nothing here (or sent from here) decides what a student is charged.
 */
document.addEventListener('DOMContentLoaded', async () => {
  const panel = document.getElementById('fee-panel');
  if (!panel) return;
  try {
    const d = await api.get('/fees/current');
    if (!d.session) return;
    panel.classList.remove('is-hidden');
    if (!d.blocks.length) {
      panel.innerHTML = `<div class="panel-header"><h3>Hostel fee — ${escapeHtml(d.session.label)}</h3></div>
        <p class="panel-note">The hostel fee for this session has not been announced yet.</p>`;
      return;
    }
    panel.innerHTML = `<div class="panel-header"><h3>Hostel fee — ${escapeHtml(d.session.label)}</h3></div>
      <div class="table-wrap"><table><thead><tr><th>Block</th><th>Fee</th></tr></thead><tbody>
      ${d.blocks.map((b) => `<tr><td>${escapeHtml(b.block_name)}${b.description ? `<br><span class="panel-note">${escapeHtml(b.description)}</span>` : ''}</td><td><strong>${escapeHtml(formatMoney(b.amount, b.currency))}</strong></td></tr>`).join('')}
      </tbody></table></div>
      <p class="panel-note">Electricity is included. The administration confirms your block when your application is approved; you then pay that block's fee for ${escapeHtml(d.session.label)}.</p>`;
  } catch (e) { /* the fee list is informational; never block applying */ }
});
