// controllers/order.controller.js
'use strict';

const orderService = require('../services/order.service');
const auditService = require('../services/audit.service');
const logger       = require('../utils/logger');

class OrderController {

  // ─── CLIENT: Place order ───────────────────────────────────────────────────
  // POST /api/v1/orders
  // Body: { items: [{ productId, skuId?, quantity }], notes? }
  async placeOrder(req, res, next) {
    try {
      const { items, notes } = req.body;

      if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ success: false, message: 'items array is required' });
      }

      const result = await orderService.placeOrder(req.user.user_id, items, notes);

      await auditService.log({
        user_id:     req.user.user_id,
        action:      'order_placed',
        entity_type: 'order',
        entity_id:   String(result.orderId),
        new_values:  { orderNumber: result.orderNumber, total: result.totalAmount, status: result.status },
        ip_address:  req.ip,
        user_agent:  req.get('User-Agent'),
      });

      res.status(201).json({
        success: true,
        message: `Order ${result.orderNumber} placed successfully`,
        data:    result,
      });
    } catch (err) { next(err); }
  }

  // ─── CLIENT: My orders ────────────────────────────────────────────────────
  // GET /api/v1/orders
  async getMyOrders(req, res, next) {
    try {
      const { status, page = 1, limit = 20 } = req.query;
      const result = await orderService.getClientOrders(req.user.user_id, {
        status, page: parseInt(page), limit: parseInt(limit),
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }

  // ─── CLIENT: Single order ─────────────────────────────────────────────────
  // GET /api/v1/orders/:id
  async getMyOrderById(req, res, next) {
    try {
      const order = await orderService.getClientOrderById(
        parseInt(req.params.id),
        req.user.user_id
      );
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      res.json({ success: true, data: order });
    } catch (err) { next(err); }
  }

  // ─── ADMIN: All orders ────────────────────────────────────────────────────
  // GET /api/v1/admin/orders
  async getAllOrders(req, res, next) {
    try {
      const { status, userId, page = 1, limit = 20 } = req.query;
      const result = await orderService.getAllOrders({
        status, userId, page: parseInt(page), limit: parseInt(limit),
      });
      res.json({ success: true, ...result });
    } catch (err) { next(err); }
  }

  // ─── ADMIN: Single order detail ───────────────────────────────────────────
  // GET /api/v1/admin/orders/:id
  async getOrderById(req, res, next) {
    try {
      const order = await orderService.getOrderById(parseInt(req.params.id));
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      res.json({ success: true, data: order });
    } catch (err) { next(err); }
  }

  // ─── ADMIN: Complete order ────────────────────────────────────────────────
  // POST /api/v1/admin/orders/:id/complete
  async completeOrder(req, res, next) {
    try {
      const orderId = parseInt(req.params.id);
      const result  = await orderService.completeOrder(orderId, req.user.user_id);

      await auditService.log({
        user_id:     req.user.user_id,
        action:      'order_completed_by_admin',
        entity_type: 'order',
        entity_id:   String(orderId),
        new_values:  { completedBy: req.user.user_id, status: result.orderStatus },
        ip_address:  req.ip,
        user_agent:  req.get('User-Agent'),
      });

      res.json({
        success: true,
        message: `Order ${result.orderNumber} fulfilled and client notified`,
        data:    result,
      });
    } catch (err) { next(err); }
  }
}

module.exports = new OrderController();
