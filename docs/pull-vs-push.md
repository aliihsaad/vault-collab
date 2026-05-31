# Pull vs Push Delivery

Vault Collab now treats pull-based attention as canonical.

Agents drain their own attention with `receive --wait` or the non-blocking
`vault_collab_receive` MCP tool. The receive path reads the session cursor,
returns relevant pings, handoffs, discussion messages, and launch notices, then
advances the cursor when items were drained.

The older push/wake broker remains in place for dashboard compatibility. The
`AttentionReceiverService`, ping wake descriptions, attention delivery attempts,
and launch-request execution lifecycle tools are deprecated in place. Do not
delete broker code or database tables until The Vault dashboard has migrated off
them.

Launch-request coordination remains active. Creating, approving, rejecting, and
cancelling launch requests are still control-plane records for operator intent;
only the broker execution transitions are deprecated by this migration.
