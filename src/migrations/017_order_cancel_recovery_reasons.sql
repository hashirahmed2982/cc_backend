-- 017_order_cancel_recovery_reasons.sql
-- Documentation-only — order_details.pending_reason already accepts any
-- VARCHAR(50), so this doesn't change what the column will store. Keeps
-- the column comment (used as the source-of-truth value list throughout
-- this codebase) in sync with two new values order.service.js#cancelOrder
-- and the two order pollers now write:
--   cancelled_recovering_supplier_cost — an admin cancelled the order
--     locally while a supplier order was already placed for this line.
--     Neither WgCards nor Gift2Games exposes a cancel/refund API, so the
--     line is deliberately left pending/partial (not failed) so the
--     pollers keep watching it, in case the supplier delivers anyway.
--   recovered_as_spare_inventory — that supplier code did arrive after
--     the order was cancelled. The customer was already refunded, so
--     it's parked as unassigned spare stock (digital_codes.order_id NULL)
--     instead of being credited to the closed order — the only real cost
--     recovery available without a supplier-side cancel API.

ALTER TABLE order_details
    MODIFY COLUMN pending_reason VARCHAR(50) NULL COMMENT 'insufficient_inventory | supplier_rejected | supplier_timeout | supplier_auth_failure | awaiting_supplier_delivery | custom_value_not_supported_yet | supplier_api_pending | requires_direct_topup_flow | delayed | delayed_needs_admin_decision | supplier_cancelled | supplier_integration_down | supplier_disabled | no_active_supplier_link | supplier_partial_delivery | cancelled_recovering_supplier_cost | recovered_as_spare_inventory';
