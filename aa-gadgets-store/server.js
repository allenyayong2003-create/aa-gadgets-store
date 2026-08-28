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

let stripe = null;
const stripeKey = process.env.STRIPE_SECRET_KEY || '';
if (stripeKey.startsWith('sk_') && !stripeKey.includes('your_secret_key_here')) {
  stripe = require('stripe')(stripeKey);
}

// ---------- Database (simple JSON file) ----------
const dbFile = path.join(__dirname, 'data', 'db.json');
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
const uploadDir = path.join(__dirname, 'public', 'images', 'products');
fs.mkdirSync(uploadDir, { recursive: true });
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
  const { name, category, price, stock, description, featured } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Name and price are required' });

  const id = 'p' + crypto.randomBytes(5).toString('hex');
  const image = req.file
    ? `/images/products/${req.file.filename}`
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
    createdAt: new Date().toISOString()
  };

  db.get('products').push(product).write();
  res.status(201).json(product);
});

app.put('/api/admin/products/:id', requireAdmin, upload.single('image'), (req, res) => {
  const product = db.get('products').find({ id: req.params.id }).value();
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const { name, category, price, stock, description, featured, imageUrl } = req.body;
  const updates = {
    name: name !== undefined ? name : product.name,
    category: category !== undefined ? category : product.category,
    price: price !== undefined ? parseFloat(price) : product.price,
    stock: stock !== undefined ? parseInt(stock, 10) : product.stock,
    description: description !== undefined ? description : product.description,
    featured: featured !== undefined ? (featured === 'true' || featured === true) : product.featured
  };

  if (req.file) {
    updates.image = `/images/products/${req.file.filename}`;
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

// ---------- Checkout (Stripe) ----------
app.post('/api/checkout', async (req, res) => {
  try {
    const { items } = req.body; // [{ id, quantity }]
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
      total += product.price * quantity;
      orderItems.push({ id: product.id, name: product.name, price: product.price, quantity });
      lineItems.push({
        price_data: {
          currency: CURRENCY,
          product_data: {
            name: product.name,
            images: product.image.startsWith('http') ? [product.image] : []
          },
          unit_amount: Math.round(product.price * 100)
        },
        quantity
      });
    }

    if (lineItems.length === 0) {
      return res.status(400).json({ error: 'No valid items in cart' });
    }

    if (!stripe) {
      // Stripe isn't configured yet — explain this clearly instead of failing silently.
      return res.status(503).json({
        error:
          'Payments are not configured yet. Add your Stripe secret key to the .env file (see .env.example) to enable checkout.'
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/cart.html`
    });

    const order = {
      id: session.id,
      items: orderItems,
      total: Math.round(total * 100) / 100,
      status: 'pending',
      paymentMethod: 'card',
      createdAt: new Date().toISOString()
    };
    db.get('orders').push(order).write();

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Something went wrong creating checkout session' });
  }
});

// ---------- Checkout (Cash on Delivery) ----------
app.post('/api/checkout/cod', (req, res) => {
  try {
    const { items, customer } = req.body; // items: [{id, quantity}], customer: {name, phone, address}

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
      total += product.price * quantity;
      orderItems.push({ id: product.id, name: product.name, price: product.price, quantity });
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
      customer: {
        name: customer.name.trim(),
        phone: customer.phone.trim(),
        address: customer.address.trim()
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

// Mark order as paid once Stripe redirects back to success.html
app.get('/api/order-status/:orderId', async (req, res) => {
  const order = db.get('orders').find({ id: req.params.orderId }).value();
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (stripe && order.paymentMethod !== 'cod' && order.status !== 'paid') {
    try {
      const session = await stripe.checkout.sessions.retrieve(req.params.orderId);
      if (session.payment_status === 'paid') {
        db.get('orders').find({ id: req.params.orderId }).assign({ status: 'paid' }).write();
        order.status = 'paid';
      }
    } catch (e) {
      // ignore lookup errors, return what we have
    }
  }
  res.json(order);
});

app.get('/api/config', (req, res) => {
  res.json({ stripeConfigured: !!stripe, currency: CURRENCY, codEnabled: true });
});

app.listen(PORT, () => {
  console.log(`A&A Gadgets store running at http://localhost:${PORT}`);
  console.log(`Admin panel at http://localhost:${PORT}/admin.html`);
  if (!stripe) {
    console.log('NOTE: Stripe is not configured. Add STRIPE_SECRET_KEY to .env to enable checkout.');
  }
});
