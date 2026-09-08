require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-password';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const CURRENCY = (process.env.CURRENCY || 'php').toLowerCase();
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

// ---------- PayMongo (online payments: card, GCash, Maya, GrabPay) ----------
const PAYMONGO_SECRET_KEY = process.env.PAYMONGO_SECRET_KEY || '';
const paymongoConfigured = PAYMONGO_SECRET_KEY.startsWith('sk_') && !PAYMONGO_SECRET_KEY.includes('your_secret_key_here');
const PAYMONGO_PAYMENT_METHODS = (process.env.PAYMONGO_PAYMENT_METHODS || 'card,gcash,paymaya,grab_pay')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

function paymongoAuthHeader() {
  return 'Basic ' + Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString('base64');
}

async function paymongoRequest(path, method, body) {
  const res = await fetch(`https://api.paymongo.com/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: paymongoAuthHeader()
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (parseErr) {
    // The response wasn't valid JSON at all — most likely a network/proxy
    // issue rather than an actual PayMongo API error. Surface something useful.
    throw new Error(`PayMongo returned an unexpected response (status ${res.status}): ${rawText.slice(0, 200)}`);
  }

  if (!res.ok) {
    const message = (data.errors && data.errors[0] && data.errors[0].detail) || 'PayMongo request failed';
    throw new Error(message);
  }
  return data;
}

// ---------- Optional email notifications (SMTP) ----------
// If SMTP_HOST/SMTP_USER/SMTP_PASS are set in .env, status-update emails will be sent.
// If not configured, the app works fine without it — customers can still use the
// "Track My Order" page to check status themselves.
let mailTransport = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const nodemailer = require('nodemailer');
  mailTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  console.log(`[email] SMTP configured — will send from ${process.env.SMTP_FROM || process.env.SMTP_USER} via ${process.env.SMTP_HOST}`);
} else {
  console.log('[email] SMTP not configured — order status emails are disabled (this is fine, Track My Order still works).');
}

async function notifyCustomerByEmail(order) {
  if (!mailTransport) {
    console.log('[email] Skipped: SMTP is not configured.');
    return;
  }
  const email = order.customer && order.customer.email;
  if (!email) {
    console.log(`[email] Skipped: order ${order.id} has no customer email on file.`);
    return;
  }
  const itemsList = order.items.map((i) => `${i.name} x${i.quantity}`).join(', ');
  console.log(`[email] Attempting to send status email for order ${order.id} to ${email}...`);
  try {
    const info = await mailTransport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: `Your A&A Gadgets order is now: ${order.fulfillmentStatus}`,
      text:
        `Hi ${(order.customer && order.customer.name) || 'there'},\n\n` +
        `Your order (${order.id}) status has been updated to: ${order.fulfillmentStatus}.\n\n` +
        `Items: ${itemsList}\n` +
        (order.trackingNumber ? `Tracking number: ${order.trackingNumber}\n` : '') +
        `\nYou can check your order anytime at ${SITE_URL}/track-order.html\n\n` +
        `Thanks for shopping with A&A Gadgets!`
    });
    console.log(`[email] Sent successfully to ${email}. Message ID: ${info.messageId}`);
  } catch (e) {
    console.error(`[email] FAILED to send to ${email}:`, e.message);
  }
}

// ---------- Order fulfillment statuses ----------
const ORDER_STATUSES = ['Order Placed', 'Processing', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled'];

// ---------- Product variants helper ----------
// Admin types variants as plain text, one group per line, e.g.:
//   Color: Black, White, Blue
//   Size: S, M, L
function parseVariantsText(text) {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex === -1) return null;
      const name = line.slice(0, separatorIndex).trim();
      const options = line
        .slice(separatorIndex + 1)
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
      if (!name || options.length === 0) return null;
      return { name, options };
    })
    .filter(Boolean);
}

function variantsToText(variants) {
  if (!Array.isArray(variants)) return '';
  return variants.map((v) => `${v.name}: ${v.options.join(', ')}`).join('\n');
}

// ---------- Variant photo overrides helper ----------
// Admin uploads one photo per variant option (e.g. one for "Black", one for
// "White") so the product image swaps when a customer picks that option.
// The uploaded files arrive in the same order as their option names, sent
// alongside as a JSON array in variantImageOptionValues.
function buildVariantImagesFromUpload(optionValuesJson, files) {
  const map = {};
  if (!optionValuesJson || !files || files.length === 0) return map;
  let optionValues;
  try {
    optionValues = JSON.parse(optionValuesJson);
  } catch (e) {
    return map;
  }
  if (!Array.isArray(optionValues)) return map;
  files.forEach((file, i) => {
    const optionValue = optionValues[i];
    if (optionValue) map[optionValue] = `/uploads/${file.filename}`;
  });
  return map;
}

// ---------- Database (simple JSON file) ----------
// This whole "data" folder should be mounted as a persistent Volume on Railway
// (see README) so product/order data and uploaded photos survive every redeploy.
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'db.json');
const adapter = new FileSync(dbFile);
const db = low(adapter);
db.defaults({ products: [], orders: [], slides: [], vouchers: [], shippingMethods: [] }).write();

// One-time migration: older products created before "reviews", "sold", or
// "images" existed won't have those fields. Add sensible defaults so every
// product has a consistent shape going forward.
db.get('products')
  .value()
  .forEach((p) => {
    const patch = {};
    if (!Array.isArray(p.reviews)) patch.reviews = [];
    if (typeof p.sold !== 'number') patch.sold = 0;
    if (!Array.isArray(p.images) || p.images.length === 0) {
      patch.images = p.image ? [p.image] : ['/images/products/placeholder-1.svg'];
    }
    if (!p.variantImages || typeof p.variantImages !== 'object') patch.variantImages = {};
    if (typeof p.warranty !== 'string') patch.warranty = '';
    if (Object.keys(patch).length > 0) {
      db.get('products').find({ id: p.id }).assign(patch).write();
    }
  });

// ---------- App setup ----------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hours
  })
);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Image upload (admin product photos) ----------
// Uploaded photos are stored inside data/uploads (part of the persistent volume),
// and served at the URL path /uploads/<filename>.
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const ok = /image\/(jpeg|png|webp|gif|svg\+xml)/.test(file.mimetype);
    cb(ok ? null : new Error('Only image files are allowed'), ok);
  }
});
const uploadMultiple = upload.array('images', 6); // up to 6 photos per product
const uploadProductImages = upload.fields([
  { name: 'images', maxCount: 6 }, // general product gallery
  { name: 'variantImageFiles', maxCount: 10 } // one file per variant option, order matches variantImageOptionValues
]);


// ---------- Auth helpers ----------
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// ---------- Public API: products ----------
app.get('/api/products', (req, res) => {
  const products = db.get('products').value();
  res.json(products);
});

app.get('/api/products/:id', (req, res) => {
  const product = db.get('products').find({ id: req.params.id }).value();
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
});

// ---------- Public: submit a product review ----------
app.post('/api/products/:id/reviews', (req, res) => {
  const product = db.get('products').find({ id: req.params.id }).value();
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { name, rating, comment } = req.body;
  const numericRating = parseInt(rating, 10);
  if (!name || !name.trim()) return res.status(400).json({ error: 'Please enter your name' });
  if (!numericRating || numericRating < 1 || numericRating > 5) {
    return res.status(400).json({ error: 'Please choose a rating from 1 to 5 stars' });
  }

  const review = {
    id: 'r' + crypto.randomBytes(6).toString('hex'),
    name: name.trim(),
    rating: numericRating,
    comment: (comment || '').trim(),
    createdAt: new Date().toISOString()
  };

  const updatedReviews = [...(product.reviews || []), review];
  db.get('products').find({ id: req.params.id }).assign({ reviews: updatedReviews }).write();
  const updated = db.get('products').find({ id: req.params.id }).value();
  res.status(201).json(updated);
});

// ---------- Admin: view and moderate all reviews ----------
app.get('/api/admin/reviews', requireAdmin, (req, res) => {
  const products = db.get('products').value();
  const allReviews = [];
  products.forEach((p) => {
    (p.reviews || []).forEach((r) => {
      allReviews.push({ ...r, productId: p.id, productName: p.name });
    });
  });
  allReviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(allReviews);
});

app.delete('/api/admin/products/:productId/reviews/:reviewId', requireAdmin, (req, res) => {
  const product = db.get('products').find({ id: req.params.productId }).value();
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const remainingReviews = (product.reviews || []).filter((r) => r.id !== req.params.reviewId);
  db.get('products').find({ id: req.params.productId }).assign({ reviews: remainingReviews }).write();
  res.json({ success: true });
});

// ---------- Admin auth routes ----------
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/admin/session', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ---------- Admin product management ----------
app.post('/api/admin/products', requireAdmin, uploadProductImages, (req, res) => {
  const { name, category, price, stock, description, featured, variantsText, variantImageOptionValues, warranty } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Name and price are required' });

  const id = 'p' + crypto.randomBytes(5).toString('hex');

  const galleryFiles = (req.files && req.files.images) || [];
  const images = galleryFiles.map((f) => `/uploads/${f.filename}`);
  if (images.length === 0) images.push('/images/products/placeholder-1.svg');

  const variantImages = buildVariantImagesFromUpload(variantImageOptionValues, req.files && req.files.variantImageFiles);

  const product = {
    id,
    name,
    category: category || 'Uncategorized',
    price: parseFloat(price),
    stock: parseInt(stock, 10) || 0,
    description: description || '',
    warranty: warranty || '',
    images,
    image: images[0], // kept for backward compatibility with older UI bits
    variantImages,
    featured: featured === 'true' || featured === true,
    variants: parseVariantsText(variantsText || ''),
    reviews: [],
    sold: 0,
    createdAt: new Date().toISOString()
  };

  db.get('products').push(product).write();
  res.status(201).json(product);
});

app.put('/api/admin/products/:id', requireAdmin, uploadProductImages, (req, res) => {
  const product = db.get('products').find({ id: req.params.id }).value();
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { name, category, price, stock, description, featured, variantsText, variantImageOptionValues, keepExistingImages, warranty } = req.body;
  const updates = {
    name: name !== undefined ? name : product.name,
    category: category !== undefined ? category : product.category,
    price: price !== undefined ? parseFloat(price) : product.price,
    stock: stock !== undefined ? parseInt(stock, 10) : product.stock,
    description: description !== undefined ? description : product.description,
    warranty: warranty !== undefined ? warranty : (product.warranty || ''),
    featured: featured !== undefined ? (featured === 'true' || featured === true) : product.featured,
    variants: variantsText !== undefined ? parseVariantsText(variantsText) : (product.variants || [])
  };

  // Variant photos: start from whatever was already saved, then layer any
  // newly uploaded photos on top (so re-uploading only some options doesn't
  // wipe out photos already set for the others).
  const newVariantImages = buildVariantImagesFromUpload(variantImageOptionValues, req.files && req.files.variantImageFiles);
  updates.variantImages = { ...(product.variantImages || {}), ...newVariantImages };

  const galleryFiles = (req.files && req.files.images) || [];
  const newImages = galleryFiles.map((f) => `/uploads/${f.filename}`);

  if (newImages.length > 0) {
    // New photos were uploaded — either add to or replace the existing gallery,
    // depending on whether the admin chose to keep the current photos.
    updates.images = keepExistingImages === 'true' ? [...(product.images || []), ...newImages] : newImages;
  } else {
    updates.images = product.images && product.images.length > 0 ? product.images : [product.image].filter(Boolean);
  }
  updates.image = updates.images[0] || '/images/products/placeholder-1.svg';

  db.get('products').find({ id: req.params.id }).assign(updates).write();
  const updated = db.get('products').find({ id: req.params.id }).value();
  res.json(updated);
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const product = db.get('products').find({ id: req.params.id }).value();
  if (!product) return res.status(404).json({ error: 'Product not found' });
  db.get('products').remove({ id: req.params.id }).write();
  res.json({ success: true });
});

// ---------- Admin: orders list ----------
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const orders = db.get('orders').orderBy(['createdAt'], ['desc']).value();
  res.json(orders);
});

// Reduces stock for each item in an order. Called once, right when an order
// is placed, so the same items can't be oversold before payment/delivery.
function decrementStockForOrder(orderItems) {
  orderItems.forEach((item) => {
    const product = db.get('products').find({ id: item.id }).value();
    if (!product) return;
    const newStock = Math.max(0, (product.stock || 0) - item.quantity);
    db.get('products').find({ id: item.id }).assign({ stock: newStock }).write();
  });
}

// Adds to each product's lifetime "sold" counter. Called once, the moment an
// order first reaches "Delivered" — reflects completed sales, not just orders placed.
function incrementSoldForOrder(orderItems) {
  orderItems.forEach((item) => {
    const product = db.get('products').find({ id: item.id }).value();
    if (!product) return;
    const newSold = (product.sold || 0) + item.quantity;
    db.get('products').find({ id: item.id }).assign({ sold: newSold }).write();
  });
}

// ---------- Checkout (PayMongo — card, GCash, Maya, GrabPay) ----------
// Looks up a shipping method and returns its fee + delivery estimate, or a
// sensible free-shipping default if none was chosen / found.
function resolveShippingMethod(shippingMethodId) {
  if (shippingMethodId) {
    const method = db.get('shippingMethods').find({ id: shippingMethodId, active: true }).value();
    if (method) return method;
  }
  return { id: null, name: 'Standard', fee: 0, estimatedDaysMin: 3, estimatedDaysMax: 7 };
}

function estimatedDeliveryDates(shippingMethod, fromDate) {
  const min = new Date(fromDate);
  min.setDate(min.getDate() + shippingMethod.estimatedDaysMin);
  const max = new Date(fromDate);
  max.setDate(max.getDate() + shippingMethod.estimatedDaysMax);
  return { min: min.toISOString(), max: max.toISOString() };
}

app.post('/api/checkout', async (req, res) => {
  try {
    const { items, shippingMethodId, voucherCode } = req.body; // [{ id, quantity, variants }]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const products = db.get('products').value();
    const lineItems = [];
    let subtotal = 0;
    const orderItems = [];

    for (const item of items) {
      const product = products.find((p) => p.id === item.id);
      if (!product) continue;
      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
      const variants = item.variants && typeof item.variants === 'object' ? item.variants : {};
      const variantSummary = Object.entries(variants).map(([k, v]) => `${k}: ${v}`).join(', ');
      subtotal += product.price * quantity;
      orderItems.push({ id: product.id, name: product.name, price: product.price, quantity, variants });
      lineItems.push({
        currency: 'PHP',
        amount: Math.round(product.price * 100), // centavos
        name: variantSummary ? `${product.name} (${variantSummary})` : product.name,
        quantity
      });
    }

    if (lineItems.length === 0) {
      return res.status(400).json({ error: 'No valid items in cart' });
    }

    if (!paymongoConfigured) {
      // PayMongo isn't configured yet — explain this clearly instead of failing silently.
      return res.status(503).json({
        error:
          'Online payments are not configured yet. Add your PayMongo secret key to the .env file (see .env.example) to enable this.'
      });
    }

    const shippingMethod = resolveShippingMethod(shippingMethodId);
    let discountAmount = 0;
    let appliedVoucher = null;
    if (voucherCode) {
      const voucherResult = checkVoucher(voucherCode, subtotal);
      if (!voucherResult.valid) return res.status(400).json({ error: voucherResult.error });
      discountAmount = voucherResult.discountAmount;
      appliedVoucher = voucherResult.voucher;
    }

    const total = Math.max(0, subtotal + shippingMethod.fee - discountAmount);

    // We generate our own order ID up front (same pattern as Cash on Delivery)
    // so we can build a success_url that already points straight at this order.
    const orderId = 'pm_' + crypto.randomBytes(8).toString('hex');

    // PayMongo doesn't support negative line item amounts, so we can only show
    // a fully itemized receipt (products + shipping) when there's no discount.
    // With a voucher applied, we fall back to one combined line item for the
    // final total so the numbers are always correct even though less detailed.
    let paymongoLineItems;
    if (discountAmount > 0) {
      paymongoLineItems = [{
        currency: 'PHP',
        amount: Math.round(total * 100),
        name: `A&A Gadgets order (voucher ${appliedVoucher.code} applied)`,
        quantity: 1
      }];
    } else {
      paymongoLineItems = [...lineItems];
      if (shippingMethod.fee > 0) {
        paymongoLineItems.push({
          currency: 'PHP',
          amount: Math.round(shippingMethod.fee * 100),
          name: `Shipping (${shippingMethod.name})`,
          quantity: 1
        });
      }
    }

    const checkoutSession = await paymongoRequest('/checkout_sessions', 'POST', {
      data: {
        attributes: {
          line_items: paymongoLineItems,
          payment_method_types: PAYMONGO_PAYMENT_METHODS,
          reference_number: orderId,
          send_email_receipt: false,
          show_line_items: true,
          success_url: `${SITE_URL}/success.html?order_id=${orderId}`,
          cancel_url: `${SITE_URL}/cart.html`
        }
      }
    });

    const delivery = estimatedDeliveryDates(shippingMethod, new Date());

    const order = {
      id: orderId,
      items: orderItems,
      subtotal: Math.round(subtotal * 100) / 100,
      shipping: { name: shippingMethod.name, fee: shippingMethod.fee, estimatedDaysMin: shippingMethod.estimatedDaysMin, estimatedDaysMax: shippingMethod.estimatedDaysMax },
      voucher: appliedVoucher ? { code: appliedVoucher.code, discountAmount } : null,
      estimatedDeliveryMin: delivery.min,
      estimatedDeliveryMax: delivery.max,
      total: Math.round(total * 100) / 100,
      status: 'pending',
      paymentMethod: 'card',
      paymongoCheckoutSessionId: checkoutSession.data.id,
      fulfillmentStatus: 'Order Placed',
      statusHistory: [{ status: 'Order Placed', at: new Date().toISOString() }],
      trackingNumber: null,
      createdAt: new Date().toISOString()
    };
    db.get('orders').push(order).write();
    decrementStockForOrder(orderItems);
    if (appliedVoucher) {
      db.get('vouchers').find({ id: appliedVoucher.id }).assign({ usedCount: appliedVoucher.usedCount + 1 }).write();
    }

    res.json({ url: checkoutSession.data.attributes.checkout_url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Something went wrong creating checkout session' });
  }
});

// ---------- Checkout (Cash on Delivery) ----------
app.post('/api/checkout/cod', (req, res) => {
  try {
    const { items, customer, shippingMethodId, voucherCode } = req.body; // items: [{id, quantity, variants}], customer: {name, phone, address, email?}

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }
    if (!customer || !customer.name || !customer.phone || !customer.address) {
      return res.status(400).json({ error: 'Name, phone, and delivery address are required for Cash on Delivery' });
    }

    const products = db.get('products').value();
    let subtotal = 0;
    const orderItems = [];

    for (const item of items) {
      const product = products.find((p) => p.id === item.id);
      if (!product) continue;
      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
      const variants = item.variants && typeof item.variants === 'object' ? item.variants : {};
      subtotal += product.price * quantity;
      orderItems.push({ id: product.id, name: product.name, price: product.price, quantity, variants });
    }

    if (orderItems.length === 0) {
      return res.status(400).json({ error: 'No valid items in cart' });
    }

    const shippingMethod = resolveShippingMethod(shippingMethodId);
    let discountAmount = 0;
    let appliedVoucher = null;
    if (voucherCode) {
      const voucherResult = checkVoucher(voucherCode, subtotal);
      if (!voucherResult.valid) return res.status(400).json({ error: voucherResult.error });
      discountAmount = voucherResult.discountAmount;
      appliedVoucher = voucherResult.voucher;
    }

    const total = Math.max(0, subtotal + shippingMethod.fee - discountAmount);
    const delivery = estimatedDeliveryDates(shippingMethod, new Date());

    const orderId = 'cod_' + crypto.randomBytes(8).toString('hex');
    const order = {
      id: orderId,
      items: orderItems,
      subtotal: Math.round(subtotal * 100) / 100,
      shipping: { name: shippingMethod.name, fee: shippingMethod.fee, estimatedDaysMin: shippingMethod.estimatedDaysMin, estimatedDaysMax: shippingMethod.estimatedDaysMax },
      voucher: appliedVoucher ? { code: appliedVoucher.code, discountAmount } : null,
      estimatedDeliveryMin: delivery.min,
      estimatedDeliveryMax: delivery.max,
      total: Math.round(total * 100) / 100,
      status: 'pending',
      paymentMethod: 'cod',
      fulfillmentStatus: 'Order Placed',
      statusHistory: [{ status: 'Order Placed', at: new Date().toISOString() }],
      trackingNumber: null,
      customer: {
        name: customer.name.trim(),
        phone: customer.phone.trim(),
        address: customer.address.trim(),
        email: customer.email ? customer.email.trim() : null
      },
      createdAt: new Date().toISOString()
    };
    db.get('orders').push(order).write();
    if (appliedVoucher) {
      db.get('vouchers').find({ id: appliedVoucher.id }).assign({ usedCount: appliedVoucher.usedCount + 1 }).write();
    }
    decrementStockForOrder(orderItems);

    res.json({ orderId });
  } catch (err) {
    console.error('COD checkout error:', err);
    res.status(500).json({ error: 'Something went wrong placing this order' });
  }
});

// Check payment status with PayMongo once the customer returns to success.html
app.get('/api/order-status/:orderId', async (req, res) => {
  const order = db.get('orders').find({ id: req.params.orderId }).value();
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (paymongoConfigured && order.paymentMethod !== 'cod' && order.paymongoCheckoutSessionId) {
    try {
      const session = await paymongoRequest(`/checkout_sessions/${order.paymongoCheckoutSessionId}`, 'GET');
      const attrs = session.data.attributes;
      const updates = {};

      const paymentIntentStatus = attrs.payment_intent && attrs.payment_intent.attributes && attrs.payment_intent.attributes.status;
      const hasPaidPayment = Array.isArray(attrs.payments) && attrs.payments.some((p) => p.attributes && p.attributes.status === 'paid');
      if ((paymentIntentStatus === 'succeeded' || hasPaidPayment) && order.status !== 'paid') {
        updates.status = 'paid';
      }

      if (attrs.billing && attrs.billing.email && !(order.customer && order.customer.email)) {
        updates.customer = {
          ...(order.customer || {}),
          email: attrs.billing.email,
          name: attrs.billing.name || (order.customer && order.customer.name) || null
        };
      }

      if (Object.keys(updates).length > 0) {
        db.get('orders').find({ id: req.params.orderId }).assign(updates).write();
        Object.assign(order, updates);
      }
    } catch (e) {
      console.error('[paymongo] status check failed:', e.message);
      // ignore lookup errors, return what we have
    }
  }
  res.json(order);
});

// ---------- Admin: update order fulfillment status ----------
app.patch('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
  const order = db.get('orders').find({ id: req.params.id }).value();
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const { status, trackingNumber } = req.body;
  if (status && !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  // Capture this before any writes — lowdb returns a live reference to the
  // stored object, so reading order.fulfillmentStatus AFTER the update below
  // would incorrectly show the new value instead of the old one.
  const previousStatus = order.fulfillmentStatus;
  const statusIsChanging = !!(status && status !== previousStatus);

  const updates = {};
  if (trackingNumber !== undefined) updates.trackingNumber = trackingNumber;
  if (statusIsChanging) {
    updates.fulfillmentStatus = status;
    updates.statusHistory = [...(order.statusHistory || []), { status, at: new Date().toISOString() }];
  }

  db.get('orders').find({ id: req.params.id }).assign(updates).write();
  const updated = db.get('orders').find({ id: req.params.id }).value();

  if (statusIsChanging) {
    notifyCustomerByEmail(updated).catch((e) => console.error('[email] notify promise rejected:', e && e.message));

    // Only count a sale once, the moment an order first reaches "Delivered".
    if (status === 'Delivered' && previousStatus !== 'Delivered') {
      incrementSoldForOrder(updated.items);
    }
  }

  res.json(updated);
});

// ---------- Public: track an order ----------
app.post('/api/track-order', (req, res) => {
  const { orderId, contact } = req.body;
  if (!orderId || !contact) {
    return res.status(400).json({ error: 'Please enter your order ID and the phone number or email used at checkout' });
  }
  const order = db.get('orders').find({ id: orderId.trim() }).value();
  if (!order) {
    return res.status(404).json({ error: 'No order found with that ID. Please double-check and try again.' });
  }
  const cleanContact = contact.trim().toLowerCase().replace(/\s+/g, '');
  const phoneMatch = order.customer && order.customer.phone && order.customer.phone.replace(/\s+/g, '') === contact.trim().replace(/\s+/g, '');
  const emailMatch = order.customer && order.customer.email && order.customer.email.toLowerCase() === cleanContact;
  if (!phoneMatch && !emailMatch) {
    return res.status(403).json({ error: 'That phone number or email does not match this order.' });
  }
  res.json(order);
});

app.get('/api/order-statuses', (req, res) => {
  res.json(ORDER_STATUSES);
});

// ---------- Homepage slideshow (admin-managed promo banners) ----------
app.get('/api/slides', (req, res) => {
  const slides = db.get('slides').orderBy(['order'], ['asc']).value();
  res.json(slides);
});

app.get('/api/admin/slides', requireAdmin, (req, res) => {
  const slides = db.get('slides').orderBy(['order'], ['asc']).value();
  res.json(slides);
});

app.post('/api/admin/slides', requireAdmin, upload.single('image'), (req, res) => {
  const { caption, linkUrl, order } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Please upload a banner image' });
  const image = `/uploads/${req.file.filename}`;

  const slide = {
    id: 's' + crypto.randomBytes(5).toString('hex'),
    image,
    caption: caption || '',
    linkUrl: linkUrl || '',
    order: parseInt(order, 10) || (db.get('slides').value().length + 1),
    createdAt: new Date().toISOString()
  };
  db.get('slides').push(slide).write();
  res.status(201).json(slide);
});

app.put('/api/admin/slides/:id', requireAdmin, upload.single('image'), (req, res) => {
  const slide = db.get('slides').find({ id: req.params.id }).value();
  if (!slide) return res.status(404).json({ error: 'Slide not found' });

  const { caption, linkUrl, order } = req.body;
  const updates = {
    caption: caption !== undefined ? caption : slide.caption,
    linkUrl: linkUrl !== undefined ? linkUrl : slide.linkUrl,
    order: order !== undefined ? parseInt(order, 10) : slide.order
  };
  if (req.file) {
    updates.image = `/uploads/${req.file.filename}`;
  }

  db.get('slides').find({ id: req.params.id }).assign(updates).write();
  res.json(db.get('slides').find({ id: req.params.id }).value());
});

app.delete('/api/admin/slides/:id', requireAdmin, (req, res) => {
  const slide = db.get('slides').find({ id: req.params.id }).value();
  if (!slide) return res.status(404).json({ error: 'Slide not found' });
  db.get('slides').remove({ id: req.params.id }).write();
  res.json({ success: true });
});

// ---------- Shipping methods (admin-managed) ----------
app.get('/api/shipping-methods', (req, res) => {
  const methods = db.get('shippingMethods').filter({ active: true }).value();
  res.json(methods);
});

app.get('/api/admin/shipping-methods', requireAdmin, (req, res) => {
  res.json(db.get('shippingMethods').value());
});

app.post('/api/admin/shipping-methods', requireAdmin, (req, res) => {
  const { name, fee, estimatedDaysMin, estimatedDaysMax, active } = req.body;
  if (!name || fee === undefined) return res.status(400).json({ error: 'Name and fee are required' });

  const method = {
    id: 'sm' + crypto.randomBytes(5).toString('hex'),
    name: name.trim(),
    fee: parseFloat(fee) || 0,
    estimatedDaysMin: parseInt(estimatedDaysMin, 10) || 1,
    estimatedDaysMax: parseInt(estimatedDaysMax, 10) || parseInt(estimatedDaysMin, 10) || 1,
    active: active !== 'false' && active !== false
  };
  db.get('shippingMethods').push(method).write();
  res.status(201).json(method);
});

app.put('/api/admin/shipping-methods/:id', requireAdmin, (req, res) => {
  const method = db.get('shippingMethods').find({ id: req.params.id }).value();
  if (!method) return res.status(404).json({ error: 'Shipping method not found' });

  const { name, fee, estimatedDaysMin, estimatedDaysMax, active } = req.body;
  const updates = {
    name: name !== undefined ? name.trim() : method.name,
    fee: fee !== undefined ? parseFloat(fee) : method.fee,
    estimatedDaysMin: estimatedDaysMin !== undefined ? parseInt(estimatedDaysMin, 10) : method.estimatedDaysMin,
    estimatedDaysMax: estimatedDaysMax !== undefined ? parseInt(estimatedDaysMax, 10) : method.estimatedDaysMax,
    active: active !== undefined ? (active === 'true' || active === true) : method.active
  };
  db.get('shippingMethods').find({ id: req.params.id }).assign(updates).write();
  res.json(db.get('shippingMethods').find({ id: req.params.id }).value());
});

app.delete('/api/admin/shipping-methods/:id', requireAdmin, (req, res) => {
  const method = db.get('shippingMethods').find({ id: req.params.id }).value();
  if (!method) return res.status(404).json({ error: 'Shipping method not found' });
  db.get('shippingMethods').remove({ id: req.params.id }).write();
  res.json({ success: true });
});

// ---------- Vouchers (admin-managed discounts) ----------
app.get('/api/admin/vouchers', requireAdmin, (req, res) => {
  res.json(db.get('vouchers').value());
});

app.post('/api/admin/vouchers', requireAdmin, (req, res) => {
  const { code, type, value, minOrder, maxUses, expiresAt, active } = req.body;
  if (!code || !type || value === undefined) {
    return res.status(400).json({ error: 'Code, type, and value are required' });
  }
  if (!['percent', 'fixed'].includes(type)) {
    return res.status(400).json({ error: 'Type must be "percent" or "fixed"' });
  }
  const normalizedCode = code.trim().toUpperCase();
  if (db.get('vouchers').find({ code: normalizedCode }).value()) {
    return res.status(400).json({ error: 'A voucher with this code already exists' });
  }

  const voucher = {
    id: 'v' + crypto.randomBytes(5).toString('hex'),
    code: normalizedCode,
    type,
    value: parseFloat(value),
    minOrder: minOrder ? parseFloat(minOrder) : 0,
    maxUses: maxUses ? parseInt(maxUses, 10) : null,
    usedCount: 0,
    expiresAt: expiresAt || null,
    active: active !== 'false' && active !== false,
    createdAt: new Date().toISOString()
  };
  db.get('vouchers').push(voucher).write();
  res.status(201).json(voucher);
});

app.put('/api/admin/vouchers/:id', requireAdmin, (req, res) => {
  const voucher = db.get('vouchers').find({ id: req.params.id }).value();
  if (!voucher) return res.status(404).json({ error: 'Voucher not found' });

  const { code, type, value, minOrder, maxUses, expiresAt, active } = req.body;
  const updates = {
    code: code !== undefined ? code.trim().toUpperCase() : voucher.code,
    type: type !== undefined ? type : voucher.type,
    value: value !== undefined ? parseFloat(value) : voucher.value,
    minOrder: minOrder !== undefined ? parseFloat(minOrder) : voucher.minOrder,
    maxUses: maxUses !== undefined ? (maxUses ? parseInt(maxUses, 10) : null) : voucher.maxUses,
    expiresAt: expiresAt !== undefined ? (expiresAt || null) : voucher.expiresAt,
    active: active !== undefined ? (active === 'true' || active === true) : voucher.active
  };
  db.get('vouchers').find({ id: req.params.id }).assign(updates).write();
  res.json(db.get('vouchers').find({ id: req.params.id }).value());
});

app.delete('/api/admin/vouchers/:id', requireAdmin, (req, res) => {
  const voucher = db.get('vouchers').find({ id: req.params.id }).value();
  if (!voucher) return res.status(404).json({ error: 'Voucher not found' });
  db.get('vouchers').remove({ id: req.params.id }).write();
  res.json({ success: true });
});

// Checks a voucher code against a cart subtotal and returns the discount if valid.
// Used by both the cart page (live preview) and the checkout endpoints (final, trusted check).
function checkVoucher(code, subtotal) {
  if (!code) return { valid: false, error: 'No voucher code provided' };
  const voucher = db.get('vouchers').find({ code: code.trim().toUpperCase() }).value();
  if (!voucher) return { valid: false, error: 'This voucher code was not found' };
  if (!voucher.active) return { valid: false, error: 'This voucher is no longer active' };
  if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
    return { valid: false, error: 'This voucher has expired' };
  }
  if (voucher.maxUses !== null && voucher.usedCount >= voucher.maxUses) {
    return { valid: false, error: 'This voucher has reached its usage limit' };
  }
  if (voucher.minOrder && subtotal < voucher.minOrder) {
    return { valid: false, error: `This voucher requires a minimum order of ${formatCurrencyForMessage(voucher.minOrder)}` };
  }
  const discountAmount = voucher.type === 'percent'
    ? Math.round(subtotal * (voucher.value / 100) * 100) / 100
    : Math.min(voucher.value, subtotal);
  return { valid: true, voucher, discountAmount };
}

function formatCurrencyForMessage(amount) {
  return `${CURRENCY.toUpperCase()} ${amount.toFixed(2)}`;
}

app.post('/api/vouchers/validate', (req, res) => {
  const { code, subtotal } = req.body;
  const result = checkVoucher(code, parseFloat(subtotal) || 0);
  if (!result.valid) return res.status(400).json({ error: result.error });
  res.json({ valid: true, code: result.voucher.code, type: result.voucher.type, value: result.voucher.value, discountAmount: result.discountAmount });
});

app.get('/api/config', (req, res) => {
  res.json({ onlinePaymentConfigured: paymongoConfigured, currency: CURRENCY, codEnabled: true });
});

app.listen(PORT, () => {
  console.log(`A&A Gadgets store running at http://localhost:${PORT}`);
  console.log(`Admin panel at http://localhost:${PORT}/admin.html`);
  if (!paymongoConfigured) {
    console.log('NOTE: PayMongo is not configured. Add PAYMONGO_SECRET_KEY to .env to enable online payments.');
  } else {
    console.log(`PayMongo configured — accepting: ${PAYMONGO_PAYMENT_METHODS.join(', ')}`);
  }
});
