// routes/product.routes.js
'use strict';
// ADD at the top after existing requires:
const path   = require('path');
const crypto = require('crypto');
const fs     = require('fs');
const express    = require('express');
const router     = express.Router();
const multer     = require('multer');
const { body, param } = require('express-validator');

const productController     = require('../controllers/product.controller');
const { protect, isAdmin }  = require('../middleware/auth');
const { validate }          = require('../middleware/validation');




// ─── Multer (in-memory, Excel only) ──────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    ext === 'xlsx' || ext === 'xls'
      ? cb(null, true)
      : cb(new Error('Only .xlsx and .xls files are allowed'), false);
  },
});
// Image upload storage — same pattern as wallet receipts
const imageUploadDir = path.join(__dirname, '../../uploads/products');
fs.mkdirSync(imageUploadDir, { recursive: true });

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, imageUploadDir),
  filename: (req, file, cb) => {
    const ext    = path.extname(file.originalname).toLowerCase();
    const unique = crypto.randomBytes(12).toString('hex');
    cb(null, `product_${unique}${ext}`);
  },
  
});

const imageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only JPG, PNG, WebP allowed'), false);
  },
});

// ─── Shared validation fragments ─────────────────────────────────────────────
const baseProductRules = [
  body('name').trim().notEmpty().withMessage('Product name is required'),
  body('category').trim().notEmpty().withMessage('Category is required'),
  body('brand').trim().notEmpty().withMessage('Brand is required'),
  body('description').trim().notEmpty().withMessage('Description is required'),
  body('redemptionInstructions').trim().notEmpty().withMessage('Redemption instructions are required'),
  body('price').isFloat({ gt: 0 }).withMessage('Valid price > 0 is required'),
  body('discountPrice').optional({ nullable: true }).isFloat({ gt: 0 }),
  body('images').optional().isArray(),
];

const supplierProductRules = [
  ...baseProductRules,
  body('supplierName').trim().notEmpty().withMessage('Supplier name is required (e.g. carrypin)'),
  body('supplierRef').trim().notEmpty().withMessage('Supplier product/SPU reference is required'),
  body('supplierSkuRef').optional().trim(),
  body('faceValue').optional().isFloat({ gt: 0 }),
  body('costPrice').optional().isFloat({ gt: 0 }),
  body('realtimePrice').optional().isBoolean(),
  body('syncEnabled').optional().isBoolean(),
];

const updateProductRules = [
  param('id').isInt().withMessage('Valid product ID required'),
  body('name').optional().trim().notEmpty(),
  body('category').optional().trim().notEmpty(),
  body('brand').optional().trim().notEmpty(),
  body('price').optional().isFloat({ gt: 0 }),
  body('discountPrice').optional({ nullable: true }).isFloat({ gt: 0 }),
  body('costPrice').optional().isFloat({ gt: 0 }),
  body('supplierRef').optional().trim(),
  body('syncEnabled').optional().isBoolean(),
  body('realtimePrice').optional().isBoolean(),
];

// ─── All routes require authentication ───────────────────────────────────────
router.use(protect);

// ─── Public meta (categories + brands) ───────────────────────────────────────
router.get('/meta', productController.getMeta);

// ─── List + single ────────────────────────────────────────────────────────────
router.get('/',    isAdmin, productController.getAll);
router.get('/:id', isAdmin, param('id').isInt(), validate, productController.getById);

// ─── Create — two distinct endpoints by product type ─────────────────────────
//
//  POST /products/internal
//    Creates an internal product with manual code uploads.
//    Body: { name, brand, category, description, redemptionInstructions,
//            price, discountPrice?, images? }
//
//  POST /products/supplier
//    Creates a supplier product (real-time fulfilment, no stored codes).
//    Body: { name, brand, category, description, redemptionInstructions,
//            price, costPrice?, faceValue?,
//            supplierName, supplierRef, supplierSkuRef?,
//            realtimePrice?, syncEnabled?, images? }
//
router.get('/images/library', isAdmin, productController.getImageLibrary);
router.delete('/images/library/:filename', isAdmin, productController.deleteImageFile);
router.patch('/bulk-status', isAdmin, productController.bulkSetStatus);
router.post('/upload-image', isAdmin, imageUpload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Image file is required' });
    }

    const baseUrl = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const url     = `${baseUrl}/uploads/products/${req.file.filename}`;

    res.json({ success: true, data: { url } });
  } catch (err) { next(err); }
});
router.post('/internal', isAdmin, baseProductRules,     validate, productController.createInternal);
router.post('/supplier', isAdmin, supplierProductRules, validate, productController.createSupplier);

// ─── Excel import ─────────────────────────────────────────────────────────────
//  POST /products/import-excel  — parse file, return preview rows (no DB write)
//  POST /products/import-bulk   — create all products from parsed row array
router.post('/import-excel', isAdmin, upload.single('file'), productController.importExcelPreview);
router.post('/import-bulk',  isAdmin, productController.importBulk);
 
// ─── Update + status + delete ────────────────────────────────────────────────
router.put(   '/:id',              isAdmin, updateProductRules, validate, productController.update);
router.patch( '/:id/toggle-status',isAdmin, param('id').isInt(), validate, productController.toggleStatus);
router.delete('/:id',              isAdmin, param('id').isInt(), validate, productController.delete);

// ─── Code management (internal products only) ────────────────────────────────
router.get( '/:id/codes',        isAdmin, param('id').isInt(), validate, productController.getCodes);
router.post('/:id/upload-codes', isAdmin, upload.single('file'), productController.uploadCodes);
router.post('/:id/upload-codes-json', isAdmin, param('id').isInt(), validate, productController.uploadCodesJson);

// ─── Supplier stock check ─────────────────────────────────────────────────────
router.get('/:id/stock-check', isAdmin, param('id').isInt(), validate, productController.stockCheck);

module.exports = router;
