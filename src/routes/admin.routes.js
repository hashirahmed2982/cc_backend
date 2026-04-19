'use strict';

const express               = require('express');
const router                = express.Router();
const adminDashboardService = require('../services/adminDashboard.service');
const { protect, isAdmin }  = require('../middleware/auth');

// GET /api/v1/admin/dashboard
router.get('/dashboard', protect, isAdmin, async (req, res, next) => {
  try {
    const data = await adminDashboardService.getSummary();
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

module.exports = router;
