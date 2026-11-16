import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createHmac } from 'node:crypto';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/naricraft_test';
process.env.JWT_SECRET = 'test-only-secret-that-is-more-than-32-characters';
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { app } = await import('../index.js');
const { default: User } = await import('../models/user.js');
const { default: OTP } = await import('../models/otpModel.js');
const { default: Product } = await import('../models/product.js');
const { default: Payment } = await import('../models/payment.js');
const { default: Order } = await import('../models/order.js');
const { createOrder, updateOrderStatus, collectProductOrderBalance } = await import('../controller/orderController.js');
const { changePasswordOTP, googleLogin, sendOTP } = await import('../controller/userController.js');
const { updateProduct } = await import('../controller/productController.js');
function response() { return { code: 200, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } }; }

// Exercise the real Express middleware without opening a network socket.
function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = new IncomingMessage(new Socket());
    req.url = path; req.method = options.method || 'GET';
    req.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([k,v]) => [k.toLowerCase(),v]));
    if (options.body) req.headers['content-length'] = Buffer.byteLength(options.body).toString();
    const res = new ServerResponse(req);
    res.end = function(body) { resolve({ status: this.statusCode, headers: this.getHeaders(), body: body?.toString() }); return this; };
    app.handle(req, res, reject);
    if (options.body) req.push(options.body);
    req.push(null);
  });
}

test('HTTP middleware: health, CORS, malformed JSON, unknown paths and invalid JWT', async () => {
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/health')).status, 503);
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/api/products')).status, 503);
  assert.equal((await request('/', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const preflight = await request('/api/products', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal((await request('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })).status, 400);
  assert.equal((await request('/api/cart', { headers: { Authorization: 'Bearer broken' } })).status, 401);
});

test('a blocked user cannot reuse an older valid JWT', async t => {
  t.mock.method(User, 'findOne', () => ({ select: async () => ({ isBlocked: true }) }));
  const token = jwt.sign({ email: 'test@example.com', role: 'admin' }, process.env.JWT_SECRET);
  const r = await request('/api/admin/users', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 403);
});

test('an incorrect OTP does not erase the valid code', async t => {
  t.mock.method(OTP, 'findOne', async () => null);
  const remove = t.mock.method(OTP, 'deleteMany', async () => { throw new Error('Must not delete'); });
  const res = response();
  await changePasswordOTP({ body: { email: 'test@example.com', otp: '123456', newPassword: 'new-password' } }, res);
  assert.equal(res.code, 400);
  assert.equal(remove.mock.callCount(), 0);
});

test('missing optional services return clear configuration errors', async () => {
  const google = process.env.GOOGLE_CLIENT_ID, resend = process.env.RESEND_API_KEY;
  delete process.env.GOOGLE_CLIENT_ID; delete process.env.RESEND_API_KEY;
  try {
    for (const fn of [googleLogin, sendOTP]) {
      const res = response(); await fn({ body: { email: 'test@example.com' } }, res); assert.equal(res.code, 503);
    }
  } finally {
    if (google !== undefined) process.env.GOOGLE_CLIENT_ID = google;
    if (resend !== undefined) process.env.RESEND_API_KEY = resend;
  }
});

test('duplicate product rows cannot bypass order stock checks', async () => {
  const res = response();
  await createOrder({ user: { email: 'test@example.com' }, body: { fullName: 'Test', phone: '0771234567', address: 'Test road', city: 'Test', district: 'Test', products: [{ productId: 'P1', quantity: 2 }, { productId: 'P1', quantity: 2 }] } }, res);
  assert.equal(res.code, 400);
});

test('product model rejects negative price and fractional stock', async () => {
  const product = new Product({ productId: 'P1', name: 'Test', description: 'Test', category: 'Test', price: -1, labelNo: 1.5 });
  await assert.rejects(product.validate(), error => Boolean(error.errors.price && error.errors.labelNo));
});

test('updating a missing product returns 404 and uses validators', async t => {
  const update = t.mock.method(Product, 'updateOne', async (filter, data, options) => {
    assert.equal(options.runValidators, true);
    assert.equal(data.$set.productId, undefined);
    return { matchedCount: 0 };
  });
  const res = response();
  await updateProduct({ user: { role: 'admin' }, params: { productId: 'missing' }, body: { name: 'Test', productId: 'changed' } }, res);
  assert.equal(res.code, 404); assert.equal(update.mock.callCount(), 1);
});

async function webhook(event, valid = true) {
  process.env.PAYMENTS_LK_SECRET_KEY = 'sk_test_local_mock_only';
  process.env.PAYMENTS_LK_WEBHOOK_SECRET = 'local-webhook-test-secret';
  const body = JSON.stringify({ object: 'event', id: 'evt_test', ...event }), time = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', process.env.PAYMENTS_LK_WEBHOOK_SECRET).update(`${time}.${body}`).digest('hex');
  return request('/api/payments/payments-lk/webhook', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'payments-signature': `t=${time},v1=${valid ? signature : '0'.repeat(64)}` } });
}
const attempt = { _id: 'local-id', paymentReference: 'TEST-REF', orderId: 'NC-TEST', orderType: 'product', requestedAmount: 100, paymentPlan: 'Full Payment', currency: 'LKR', status: 'Pending' };
const event = { id: 'evt_test', type: 'payment.succeeded', data: { reference: 'TEST-REF', currency: 'LKR', amountCents: 10000 } };

test('webhook verifies the exact raw body and rejects invalid signatures', async () => {
  assert.equal((await webhook({ type: 'test.ping' })).status, 200);
  assert.equal((await webhook(event, false)).status, 400);
});

test('webhook rejects a payment with the wrong amount', async t => {
  t.mock.method(Payment, 'findOne', async () => attempt);
  const result = await webhook({ ...event, data: { ...event.data, amountCents: 1 } });
  assert.equal(result.status, 400); assert.equal(result.body, 'Amount mismatch');
});

test('verified full payment applies its reference and uses conditional writes', async t => {
  t.mock.method(Payment, 'findOne', async () => attempt);
  t.mock.method(Order, 'findOne', async () => ({ totalPrice: 100, paymentStatus: 'Payment Pending' }));
  const orderWrite = t.mock.method(Order, 'findOneAndUpdate', async (filter, update) => {
    assert.ok(filter.paymentStatus.$nin.includes('Paid'));
    assert.equal(update.$set.appliedPaymentReference, 'TEST-REF');
    assert.equal(update.$set.paidAmount, 100); assert.equal(update.$set.remainingAmount, 0);
    return update.$set;
  });
  t.mock.method(Payment, 'findOneAndUpdate', async () => ({}));
  assert.equal((await webhook(event)).status, 200);
  assert.equal(orderWrite.mock.callCount(), 1);
});

test('a duplicate successful webhook leaves the order unchanged', async t => {
  t.mock.method(Payment, 'findOne', async () => ({ ...attempt, status: 'Success' }));
  t.mock.method(Order, 'findOne', async () => ({ totalPrice: 100, paymentStatus: 'Paid' }));
  const write = t.mock.method(Order, 'findOneAndUpdate', async () => { throw new Error('No duplicate write'); });
  assert.equal((await webhook(event)).status, 200); assert.equal(write.mock.callCount(), 0);
});

test('a retry repairs a saved order without overwriting its collected balance', async t => {
  t.mock.method(Payment, 'findOne', async () => attempt);
  t.mock.method(Order, 'findOne', async () => ({ totalPrice: 100, paymentStatus: 'Paid', appliedPaymentReference: 'TEST-REF' }));
  const write = t.mock.method(Order, 'findOneAndUpdate', async () => { throw new Error('No order overwrite'); });
  const repair = t.mock.method(Payment, 'findOneAndUpdate', async () => ({}));
  assert.equal((await webhook(event)).status, 200); assert.equal(write.mock.callCount(), 0); assert.equal(repair.mock.callCount(), 1);
});

const validOrderRequest = () => ({ user: { email: 'test@example.com' }, body: { fullName: 'Test', phone: '0771234567', address: 'Test road', city: 'Test', district: 'Test', products: [{ productId: 'P1', quantity: 2 }] } });

test('new orders reserve stock and save inside the same transaction', async t => {
  const session = {};
  t.mock.method(mongoose.connection, 'transaction', async callback => callback(session));
  t.mock.method(Product, 'findOne', async () => ({ productId: 'P1', name: 'Test', price: 10, labelNo: 3, images: [] }));
  const reserve = t.mock.method(Product, 'updateOne', async (filter, update, options) => {
    assert.equal(filter.labelNo.$gte, 2); assert.equal(filter.price, 10);
    assert.equal(update.$inc.labelNo, -2); assert.equal(options.session, session);
    return { modifiedCount: 1 };
  });
  t.mock.method(Order.prototype, 'save', async function(options) {
    assert.equal(options.session, session); assert.equal(this.inventoryReserved, true); return this;
  });
  const res = response(); await createOrder(validOrderRequest(), res);
  assert.equal(res.code, 201); assert.equal(res.body.order.totalPrice, 20); assert.equal(reserve.mock.callCount(), 1);
});

test('a stock race aborts order creation instead of overselling', async t => {
  t.mock.method(mongoose.connection, 'transaction', async callback => callback({}));
  t.mock.method(Product, 'findOne', async () => ({ productId: 'P1', name: 'Test', price: 10, labelNo: 3 }));
  t.mock.method(Product, 'updateOne', async () => ({ modifiedCount: 0 }));
  const save = t.mock.method(Order.prototype, 'save', async () => { throw new Error('Must not save'); });
  const res = response(); await createOrder(validOrderRequest(), res);
  assert.equal(res.code, 409); assert.equal(save.mock.callCount(), 0);
});

test('cancelling an order restores reserved stock only once', async t => {
  const order = { inventoryReserved: true, status: 'Pending', products: [{ productId: 'P1', quantity: 2 }], async save() { return this; } };
  t.mock.method(mongoose.connection, 'transaction', async callback => callback({}));
  t.mock.method(Order, 'findOne', () => ({ session: async () => order }));
  const restore = t.mock.method(Product, 'updateOne', async (filter, update) => { assert.equal(update.$inc.labelNo, 2); return {}; });
  const req = { user: { role: 'admin' }, params: { orderId: 'NC-TEST' }, body: { status: 'Cancelled' } };
  for (let i = 0; i < 2; i++) { const res = response(); await updateOrderStatus(req, res); assert.equal(res.code, 200); }
  assert.equal(restore.mock.callCount(), 1);
  const res = response(); await updateOrderStatus({ ...req, body: { status: 'Pending' } }, res); assert.equal(res.code, 409);
});

test('wrong OTP increments the attempt counter; five failures require a new code', async t => {
  const record = { _id: 'otp-test', otp: '654321', failedAttempts: 0 };
  t.mock.method(OTP, 'findOne', async () => record);
  const increment = t.mock.method(OTP, 'updateOne', async () => { record.failedAttempts++; });
  const req = { body: { email: 'test@example.com', otp: '123456', newPassword: 'new-password' } };
  for (let i = 0; i < 5; i++) { const res = response(); await changePasswordOTP(req, res); assert.equal(res.code, 400); }
  const res = response(); await changePasswordOTP(req, res);
  assert.equal(res.code, 429); assert.equal(increment.mock.callCount(), 5);
});

test('product balance collection requires admin access and a conditional pending balance', async t => {
  const denied = response(); await collectProductOrderBalance({ user: { role: 'user' } }, denied); assert.equal(denied.code, 403);
  t.mock.method(Order, 'findOne', async () => ({ orderId: 'NC-TEST', totalPrice: 100, remainingAmount: 50, status: 'Shipped', paymentPlan: 'Half Payment', paymentStatus: 'Partially Paid', balanceStatus: 'Pending' }));
  t.mock.method(Order, 'findOneAndUpdate', async (filter, update, options) => {
    assert.equal(filter.paymentStatus, 'Partially Paid'); assert.equal(filter.remainingAmount, 50);
    assert.equal(update.$set.paidAmount, 100); assert.equal(update.$set.remainingAmount, 0); assert.equal(options.runValidators, true);
    return update.$set;
  });
  const res = response(); await collectProductOrderBalance({ user: { role: 'admin' }, params: { orderId: 'NC-TEST' } }, res); assert.equal(res.body.order.paymentStatus, 'Paid');
});
