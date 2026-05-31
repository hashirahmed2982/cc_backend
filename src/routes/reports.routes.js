'use strict';
// src/routes/reports.routes.js

const express        = require('express');
const router         = express.Router();
const reportsService = require('../services/reports.service');
const { protect, isAdmin } = require('../middleware/auth');
const { query }      = require('express-validator');
const { validate }   = require('../middleware/validation');

router.use(protect, isAdmin);

const dateValidation = [
  query('from').optional().isDate().withMessage('from must be YYYY-MM-DD'),
  query('to').optional().isDate().withMessage('to must be YYYY-MM-DD'),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 500 }),
];

/**
 * GET /api/v1/reports/:reportId
 * Query params: from, to, page, limit
 */
router.get('/:reportId', dateValidation, validate, async (req, res, next) => {
  try {
    const { reportId } = req.params;
    const { from, to, page, limit } = req.query;

    const data = await reportsService.getReport(reportId, {
      from:  from  || null,
      to:    to    || null,
      page:  page  ? parseInt(page)  : 1,
      limit: limit ? parseInt(limit) : 100,
    });

    res.json({ success: true, data });
  } catch (err) {
    if (err.message?.startsWith('Unknown report')) {
      return res.status(404).json({ success: false, message: err.message });
    }
    next(err);
  }
});

module.exports = router;
