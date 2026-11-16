import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import Order from "../models/order.js";

import Product from "../models/product.js";

import { isAdmin } from "./userController.js";

export async function collectProductOrderBalance(req, res) {
  if (!isAdmin(req)) return res.status(403).json({ message: "Forbidden" });
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.status === "Cancelled" || order.paymentPlan !== "Half Payment" || order.paymentStatus !== "Partially Paid" || order.balanceStatus !== "Pending" || !(order.remainingAmount > 0)) {
      return res.status(409).json({ message: "This order has no collectable balance" });
    }
    const updated = await Order.findOneAndUpdate(
      { orderId: order.orderId, status: { $ne: "Cancelled" }, paymentStatus: "Partially Paid", balanceStatus: "Pending", remainingAmount: order.remainingAmount },
      { $set: { paidAmount: order.totalPrice, remainingAmount: 0, paymentStatus: "Paid", balanceStatus: "Collected", paymentCompletedAt: new Date() } },
      { new: true, runValidators: true },
    );
    if (!updated) return res.status(409).json({ message: "Order changed. Refresh and try again." });
    res.json({ message: "Remaining balance marked as collected", order: updated });
  } catch (error) {
    console.error("Collect balance:", error.message);
    res.status(500).json({ message: "Could not record the collected balance" });
  }
}

// =====================================================
// CREATE ORDER
// =====================================================

export async function createOrder(req, res) {
  try {
    // =================================================
    // CHECK USER
    // =================================================

    const user = req.user;

    if (user == null) {
      res.status(401).json({
        message: "Unauthorized",
      });

      return;
    }

    // =================================================
    // CUSTOMER EMAIL
    // =================================================

    const customerEmail = user.email?.toString().trim().toLowerCase();

    if (!customerEmail) {
      res.status(400).json({
        message: "User email not found",
      });

      return;
    }

    // =================================================
    // GET LAST ORDER
    // =================================================

    const newOrderId = "NC" + randomUUID().replaceAll("-", "").toUpperCase();

    let customerName = req.body.fullName;

    if (customerName == null || customerName.toString().trim() === "") {
      customerName = user.fullName || user.firstName || "";
    }

    customerName = customerName.toString().trim();

    // =================================================
    // CUSTOMER PHONE
    //
    // Current User model uses telephone.
    // phone fallback kept for older accounts.
    // =================================================

    let customerPhone = req.body.phone;

    if (customerPhone == null || customerPhone.toString().trim() === "") {
      customerPhone = user.telephone || user.phone || "";
    }

    customerPhone = customerPhone.toString().trim();

    // =================================================
    // DELIVERY DETAILS
    // =================================================

    const address = req.body.address?.toString().trim() || "";

    const city = req.body.city?.toString().trim() || "";

    const district = req.body.district?.toString().trim() || "";

    const notes = req.body.notes?.toString().trim() || "";

    // =================================================
    // VALIDATE CUSTOMER DETAILS
    // =================================================

    if (
      customerName === "" ||
      customerPhone === "" ||
      address === "" ||
      city === "" ||
      district === ""
    ) {
      res.status(400).json({
        message: "Customer and delivery details are required",
      });

      return;
    }

    // =================================================
    // GET PRODUCTS FROM REQUEST
    // =================================================

    const itemsInRequest = req.body.products;

    if (itemsInRequest == null) {
      res.status(400).json({
        message: "Products are required",
      });

      return;
    }

    if (!Array.isArray(itemsInRequest) || itemsInRequest.length === 0) {
      res.status(400).json({
        message: "Products must be a non-empty array",
      });

      return;
    }

    // =================================================
    // PREPARE PRODUCTS
    // =================================================

    const seenProducts = new Set();
    for (const item of itemsInRequest) {
      if (!item || typeof item.productId !== "string" || seenProducts.has(item.productId.trim())) {
        return res.status(400).json({ message: "Products must have unique valid product IDs" });
      }
      seenProducts.add(item.productId.trim());
    }
    const productsToBeAdded = [];

    let total = 0;

    for (let i = 0; i < itemsInRequest.length; i++) {
      const item = itemsInRequest[i];

      // ===============================================
      // PRODUCT ID
      // ===============================================

      const productId = item.productId?.toString().trim();

      if (!productId) {
        res.status(400).json({
          message: "Product ID is required",
        });

        return;
      }

      // ===============================================
      // VALIDATE QUANTITY
      // ===============================================

      const quantity = Number(item.quantity);

      if (!Number.isInteger(quantity) || quantity < 1) {
        res.status(400).json({
          message: "Product quantity must be at least 1",

          productId: productId,
        });

        return;
      }

      // ===============================================
      // FIND PRODUCT
      // ===============================================

      const product = await Product.findOne({
        productId: productId,
      });

      if (product == null) {
        res.status(400).json({
          code: "NOT_FOUND",

          message: "Product not found",

          productId: productId,
        });

        return;
      }

      // ===============================================
      // CHECK PRODUCT PRICE
      // ===============================================

      const productPrice = Number(product.price);

      if (!Number.isFinite(productPrice) || productPrice < 0) {
        res.status(400).json({
          message: "Invalid product price",

          productId: productId,
        });

        return;
      }

      // ===============================================
      // CHECK STOCK
      //
      // labelNo = stock quantity
      // ===============================================

      const availableStock = Number(product.labelNo);

      if (!Number.isFinite(availableStock) || availableStock < quantity) {
        res.status(400).json({
          code: "STOCK",

          message: "Product does not have enough stock",

          productId: productId,

          availableStock: Number.isFinite(availableStock) ? availableStock : 0,
        });

        return;
      }

      // ===============================================
      // ADD PRODUCT TO ORDER
      // ===============================================

      productsToBeAdded.push({
        productId: product.productId,

        name: product.name,

        price: productPrice,

        quantity: quantity,

        image: product.images?.[0] || "",
      });

      // ===============================================
      // CALCULATE TOTAL
      //
      // IMPORTANT:
      // Real price is always calculated from DB.
      // Frontend total is NOT trusted.
      // ===============================================

      total += quantity * productPrice;
    }

    // =================================================
    // MONEY ROUNDING
    // =================================================

    total = Math.round(total * 100) / 100;

    // =================================================
    // VALIDATE TOTAL
    // =================================================

    if (!Number.isFinite(total) || total <= 0) {
      res.status(400).json({
        message: "Invalid order total",
      });

      return;
    }

    // =================================================
    // CREATE ORDER
    // =================================================

    const newOrder = new Order({
      orderId: newOrderId,

      fullName: customerName,

      phone: customerPhone,

      email: customerEmail,

      address: address,

      city: city,

      district: district,

      notes: notes,

      products: productsToBeAdded,

      totalPrice: total,

      status: "Pending",

      // =============================================
      // PAYMENT DEFAULTS
      // =============================================

      paymentPlan: null,

      paymentStatus: "Payment Pending",

      paidAmount: 0,

      // FIX:
      // This was incorrectly `totalPrice`.
      // Current calculated variable is `total`.
      remainingAmount: total,

      balanceStatus: "Not Applicable",

      payherePaymentId: "",

      onlinePaymentAt: null,

      paymentCompletedAt: null,
    });

    // =================================================
    // SAVE ORDER
    // =================================================

    // Reserve all products and save the order as one atomic MongoDB transaction.
    // Atlas supports this; a local MongoDB must run as a replica set.
    const savedOrder = await mongoose.connection.transaction(async session => {
      for (const item of productsToBeAdded) {
        const reserved = await Product.updateOne(
          { productId: item.productId, price: item.price, labelNo: { $gte: item.quantity } },
          { $inc: { labelNo: -item.quantity } },
          { session, runValidators: true },
        );
        if (reserved.modifiedCount !== 1) {
          const error = new Error("Stock or price changed. Refresh your cart and try again.");
          error.status = 409;
          throw error;
        }
      }
      newOrder.inventoryReserved = true;
      return newOrder.save({ session });
    });

    // =================================================
    // RESPONSE
    // =================================================

    res.status(201).json({
      message: "Order created successfully",

      order: savedOrder,
    });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ message: err.message });
    if (err.code === 20) return res.status(503).json({ message: "Ordering requires MongoDB Atlas or a local replica set for stock transactions" });
    console.error("Create Order Error:", err.message);

    res.status(500).json({
      message: "Internal server error",

      error: err.message,
    });
  }
}

// =====================================================
// GET ORDERS
//
// Admin    -> all orders
// Customer -> own orders only
// =====================================================

export async function getOrders(req, res) {
  try {
    const user = req.user;

    // =================================================
    // CHECK LOGIN
    // =================================================

    if (user == null) {
      res.status(401).json({
        message: "Unauthorized",
      });

      return;
    }

    // =================================================
    // ADMIN
    // =================================================

    if (user.role?.toLowerCase() === "admin") {
      const allOrders = await Order.find().sort({
        date: -1,
      });

      res.status(200).json(allOrders);

      return;
    }

    // =================================================
    // CUSTOMER EMAIL
    // =================================================

    const customerEmail = user.email?.toString().trim().toLowerCase();

    if (!customerEmail) {
      res.status(400).json({
        message: "User email not found",
      });

      return;
    }

    // =================================================
    // CUSTOMER OWN ORDERS
    // =================================================

    const orders = await Order.find({
      email: customerEmail,
    }).sort({
      date: -1,
    });

    // =================================================
    // RESPONSE
    // =================================================

    res.status(200).json(orders);
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ message: err.message });
    if (err.code === 20) return res.status(503).json({ message: "Ordering requires MongoDB Atlas or a local replica set for stock transactions" });
    console.error("Get Orders Error:", err.message);

    res.status(500).json({
      message: "Internal server error",

      error: err.message,
    });
  }
}

// =====================================================
// UPDATE ORDER STATUS
// ADMIN ONLY
// =====================================================

export async function updateOrderStatus(req, res) {
  // ===================================================
  // ADMIN CHECK
  // ===================================================

  if (!isAdmin(req)) {
    res.status(403).json({
      message: "Forbidden",
    });

    return;
  }

  // ===================================================
  // ORDER ID
  // ===================================================

  const orderId = req.params.orderId?.toString().trim();

  if (!orderId) {
    res.status(400).json({
      message: "Order ID is required",
    });

    return;
  }

  // ===================================================
  // NEW STATUS
  // ===================================================

  const newStatus = req.body.status;

  // ===================================================
  // ALLOWED STATUSES
  // ===================================================

  const allowedStatuses = [
    "Pending",
    "Confirmed",
    "Processing",
    "Shipped",
    "Delivered",
    "Cancelled",
  ];

  // ===================================================
  // VALIDATE STATUS
  // ===================================================

  if (!allowedStatuses.includes(newStatus)) {
    res.status(400).json({
      message: "Invalid order status",
    });

    return;
  }

  try {
    // =================================================
    // UPDATE ORDER
    // =================================================

    const updatedOrder = await mongoose.connection.transaction(async session => {
      const order = await Order.findOne({ orderId }).session(session);
      if (!order) return null;
      if (order.status === "Cancelled" && newStatus !== "Cancelled") {
        const error = new Error("Cancelled orders cannot be reopened. Create a new order.");
        error.status = 409;
        throw error;
      }
      if (newStatus === "Cancelled" && order.inventoryReserved) {
        for (const item of order.products) {
          await Product.updateOne({ productId: item.productId }, { $inc: { labelNo: item.quantity } }, { session });
        }
        order.inventoryReserved = false;
      }
      order.status = newStatus;
      return order.save({ session });
    });

    if (updatedOrder == null) {
      res.status(404).json({
        message: "Order not found",
      });

      return;
    }

    // =================================================
    // RESPONSE
    // =================================================

    res.status(200).json({
      message: "Order updated successfully",

      order: updatedOrder,
    });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ message: err.message });
    if (err.code === 20) return res.status(503).json({ message: "Ordering requires MongoDB Atlas or a local replica set for stock transactions" });
    console.error("Update Order Status Error:", err.message);

    res.status(500).json({
      message: "Internal server error",

      error: err.message,
    });
  }
}
