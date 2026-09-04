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

// ---------- Database (simple JSON file) ----------
// This whole "data" folder should be mounted as a persistent Volume on Railway
// (see README) so product/order data and uploaded photos survive every redeploy.
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'db.json');
const adapter = new FileSync(dbFile);
const db = low(adapter);
db.defaults({ products: [], orders: [] }).write();

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
app.post('/api/admin/products', requireAdmin, upload.single('image'), (req, res) => {
  const { name, category, price, stock, description, featured, variantsText } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Name and price are required' });

  const id = 'p' + crypto.randomBytes(5).toString('hex');
  const image = req.file
    ? `/uploads/${req.file.filename}`
    : req.body.imageUrl || '/images/products/placeholder-1.svg';

  const product = {
    id,
    name,
    category: category || 'Uncategorized',
    price: parseFloat(price),
    stock: parseInt(stock, 10) || 0,
    description: description || '',
    image,
    featured: featured === 'true' || featured === true,
    variants: parseVariantsText(variantsText || ''),
    createdAt: new Date().toISOString()
  };

  db.get('products').push(product).write();
  res.status(201).json(product);
});

app.put('/api/admin/products/:id', requireAdmin, upload.single('image'), (req, res) => {
  const product = db.get('products').find({ id: req.params.id }).value();
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { name, category, price, stock, description, featured, imageUrl, variantsText } = req.body;
  const updates = {
    name: name !== undefined ? name : product.name,
    category: category !== undefined ? category : product.category,
    price: price !== undefined ? parseFloat(price) : product.price,
    stock: stock !== undefined ? parseInt(stock, 10) : product.stock,
    description: description !== undefined ? description : product.description,
    featured: featured !== undefined ? (featured === 'true' || featured === true) : product.featured,
    variants: variantsText !== undefined ? parseVariantsText(variantsText) : (product.variants || [])
  };

  if (req.file) {
    updates.image = `/uploads/${req.file.filename}`;
  } else if (imageUrl) {
    updates.image = imageUrl;
  }

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

// ---------- Checkout (PayMongo — card, GCash, Maya, GrabPay) ----------
app.post('/api/checkout', async (req, res) => {
  try {
    const { items } = req.body; // [{ id, quantity, variants }]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const products = db.get('products').value();
    const lineItems = [];
    let total = 0;
    const orderItems = [];

    for (const item of items) {
      const product = products.find((p) => p.id === item.id);
      if (!product) continue;
      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
      const variants = item.variants && typeof item.variants === 'object' ? item.variants : {};
      const variantSummary = Object.entries(variants).map(([k, v]) => `${k}: ${v}`).join(', ');
      total += product.price * quantity;
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

    // We generate our own order ID up front (same pattern as Cash on Delivery)
    // so we can build a success_url that already points straight at this order.
    const orderId = 'pm_' + crypto.randomBytes(8).toString('hex');

    const checkoutSession = await paymongoRequest('/checkout_sessions', 'POST', {
      data: {
        attributes: {
          line_items: lineItems,
          payment_method_types: PAYMONGO_PAYMENT_METHODS,
          reference_number: orderId,
          send_email_receipt: false,
          show_line_items: true,
          success_url: `${SITE_URL}/success.html?order_id=${orderId}`,
          cancel_url: `${SITE_URL}/cart.html`
        }
      }
    });

    const order = {
      id: orderId,
      items: orderItems,
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

    res.json({ url: checkoutSession.data.attributes.checkout_url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Something went wrong creating checkout session' });
  }
});

// ---------- Checkout (Cash on Delivery) ----------
app.post('/api/checkout/cod', (req, res) => {
  try {
    const { items, customer } = req.body; // items: [{id, quantity, variants}], customer: {name, phone, address, email?}

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }
    if (!customer || !customer.name || !customer.phone || !customer.address) {
      return res.status(400).json({ error: 'Name, phone, and delivery address are required for Cash on Delivery' });
    }

    const products = db.get('products').value();
    let total = 0;
    const orderItems = [];

    for (const item of items) {
      const product = products.find((p) => p.id === item.id);
      if (!product) continue;
      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
      const variants = item.variants && typeof item.variants === 'object' ? item.variants : {};
      total += product.price * quantity;
      orderItems.push({ id: product.id, name: product.name, price: product.price, quantity, variants });
    }

    if (orderItems.length === 0) {
      return res.status(400).json({ error: 'No valid items in cart' });
    }

    const orderId = 'cod_' + crypto.randomBytes(8).toString('hex');
    const order = {
      id: orderId,
      items: orderItems,
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
