// jobs/_supplierGate.js
// Shared "is this supplier turned on" check for every per-supplier cron
// job — supplier_config.is_active is the admin on/off switch (point 4 of
// the multi-supplier admin requirements: "a option to disable or enable
// any particular supplier at any time"). A disabled supplier is a strict
// superset of "down": no cron job should call it at all — there's nothing
// to sync/poll/health-check for a supplier the admin has deliberately
// turned off, and calling it anyway wastes rate limit and can flip the
// circuit breaker on transient failures nobody's watching for.
'use strict';

const supplierConfigRepo = require('../repositories/supplierConfig.repository');

/** Returns { enabled: boolean, configured: boolean }. `configured: false`
 * means there's no supplier_config row at all yet (e.g. Gift2Games before
 * credentials are seeded) — treated the same as disabled for job purposes,
 * but callers may want to log it differently. */
async function checkSupplierEnabled(supplierName) {
  const cfg = await supplierConfigRepo.getBySupplierName(supplierName);
  if (!cfg) return { enabled: false, configured: false };
  return { enabled: !!cfg.is_active, configured: true };
}

module.exports = { checkSupplierEnabled };
