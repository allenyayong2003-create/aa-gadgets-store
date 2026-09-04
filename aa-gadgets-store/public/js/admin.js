let ADMIN_PRODUCTS = [];
let ADMIN_CURRENCY = 'usd';

async function loadCurrency() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    ADMIN_CURRENCY = config.currency || 'usd';
  } catch (e) {
    ADMIN_CURRENCY = 'usd';
  }
}

// ---------- Boot ----------
async function boot() {
  const res = await fetch('/api/admin/session');
  const { isAdmin } = await res.json();
  if (isAdmin) {
    showDashboard();
  } else {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('loginShell').style.display = 'flex';
  document.getElementById('adminShell').style.display = 'none';
}

async function showDashboard() {
  document.getElementById('loginShell').style.display = 'none';
  document.getElementById('adminShell').style.display = 'flex';
  await loadCurrency();
  loadProducts();
}

// ---------- Login ----------
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('loginError');
  errorEl.style.display = 'none';

  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  if (res.ok) {
    showDashboard();
  } else {
    errorEl.style.display = 'block';
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  showLogin();
});

// ---------- Nav switching ----------
document.querySelectorAll('.admin-nav a[data-view]').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.admin-nav a[data-view]').forEach((l) => l.classList.remove('active'));
    link.classList.add('active');
    const view = link.dataset.view;
    document.getElementById('view-products').style.display = view === 'products' ? 'block' : 'none';
    document.getElementById('view-orders').style.display = view === 'orders' ? 'block' : 'none';
    if (view === 'orders') loadOrders();
  });
});

// ---------- Products: load + render ----------
async function loadProducts() {
  const res = await fetch('/api/products');
  ADMIN_PRODUCTS = await res.json();
  renderProductTable();
  renderStats();
}

function renderStats() {
  document.getElementById('statTotal').textContent = ADMIN_PRODUCTS.length;
  const lowStock = ADMIN_PRODUCTS.filter((p) => p.stock <= 5).length;
  document.getElementById('statLowStock').textContent = lowStock;
  const value = ADMIN_PRODUCTS.reduce((sum, p) => sum + p.price * p.stock, 0);
  document.getElementById('statValue').textContent = formatMoney(value, ADMIN_CURRENCY);
}

function renderProductTable() {
  const body = document.getElementById('productTableBody');
  if (ADMIN_PRODUCTS.length === 0) {
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:32px;">No products yet — add your first one above.</td></tr>';
    return;
  }
  body.innerHTML = ADMIN_PRODUCTS.map((p) => {
    const variantsSummary = (p.variants || []).length
      ? p.variants.map((v) => `${v.name} (${v.options.length})`).join(', ')
      : '—';
    return `
    <tr>
      <td><img class="admin-thumb" src="${p.image}" alt="${escapeAttr(p.name)}"></td>
      <td>${escapeAttr(p.name)}</td>
      <td>${escapeAttr(p.category)}</td>
      <td style="font-size:12px;color:var(--muted);">${escapeAttr(variantsSummary)}</td>
      <td>${formatMoney(p.price, ADMIN_CURRENCY)}</td>
      <td>
        ${p.stock === 0
          ? '<span class="badge badge-low">Out</span>'
          : p.stock <= 5
            ? `<span class="badge badge-low">${p.stock} left</span>`
            : `${p.stock}`}
      </td>
      <td>${p.featured ? '✓' : '—'}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-small btn-outline" onclick="editProduct('${p.id}')">Edit</button>
          <button class="btn btn-small btn-danger" onclick="deleteProduct('${p.id}')">Delete</button>
        </div>
      </td>
    </tr>
  `;
  }).join('');
}

function escapeAttr(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ---------- Product form ----------
const formCard = document.getElementById('productFormCard');
const productForm = document.getElementById('productForm');

document.getElementById('newProductBtn').addEventListener('click', () => {
  productForm.reset();
  document.getElementById('productId').value = '';
  document.getElementById('formTitle').textContent = 'Add product';
  document.getElementById('formError').style.display = 'none';
  formCard.style.display = 'block';
  formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.getElementById('cancelFormBtn').addEventListener('click', () => {
  formCard.style.display = 'none';
});

function editProduct(id) {
  const p = ADMIN_PRODUCTS.find((x) => x.id === id);
  if (!p) return;
  document.getElementById('productId').value = p.id;
  document.getElementById('pName').value = p.name;
  document.getElementById('pCategory').value = p.category;
  document.getElementById('pPrice').value = p.price;
  document.getElementById('pStock').value = p.stock;
  document.getElementById('pDescription').value = p.description || '';
  document.getElementById('pVariants').value = (p.variants || []).map((v) => `${v.name}: ${v.options.join(', ')}`).join('\n');
  document.getElementById('pImageUrl').value = p.image.startsWith('http') ? p.image : '';
  document.getElementById('pImageFile').value = '';
  document.getElementById('pFeatured').checked = !!p.featured;
  document.getElementById('formTitle').textContent = `Edit ${p.name}`;
  document.getElementById('formError').style.display = 'none';
  formCard.style.display = 'block';
  formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

productForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('productId').value;
  const formData = new FormData();
  formData.append('name', document.getElementById('pName').value.trim());
  formData.append('category', document.getElementById('pCategory').value.trim());
  formData.append('price', document.getElementById('pPrice').value);
  formData.append('stock', document.getElementById('pStock').value);
  formData.append('description', document.getElementById('pDescription').value.trim());
  formData.append('variantsText', document.getElementById('pVariants').value);
  formData.append('featured', document.getElementById('pFeatured').checked);

  const imageUrl = document.getElementById('pImageUrl').value.trim();
  if (imageUrl) formData.append('imageUrl', imageUrl);

  const fileInput = document.getElementById('pImageFile');
  if (fileInput.files[0]) formData.append('image', fileInput.files[0]);

  const url = id ? `/api/admin/products/${id}` : '/api/admin/products';
  const method = id ? 'PUT' : 'POST';

  const res = await fetch(url, { method, body: formData });
  const errorEl = document.getElementById('formError');

  if (res.ok) {
    formCard.style.display = 'none';
    showToast(id ? 'Product updated' : 'Product added');
    loadProducts();
  } else {
    const data = await res.json().catch(() => ({}));
    errorEl.textContent = data.error || 'Something went wrong saving this product.';
    errorEl.style.display = 'block';
  }
});

async function deleteProduct(id) {
  const p = ADMIN_PRODUCTS.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`Delete "${p.name}"? This can't be undone.`)) return;
  const res = await fetch(`/api/admin/products/${id}`, { method: 'DELETE' });
  if (res.ok) {
    showToast('Product deleted');
    loadProducts();
  } else {
    showToast('Could not delete product');
  }
}

// ---------- Orders ----------
const ORDER_STATUSES = ['Order Placed', 'Processing', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled'];

async function loadOrders() {
  const res = await fetch('/api/admin/orders');
  const body = document.getElementById('orderTableBody');
  if (!res.ok) {
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:32px;">Could not load orders.</td></tr>';
    return;
  }
  const orders = await res.json();
  if (orders.length === 0) {
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:32px;">No orders yet.</td></tr>';
    return;
  }
  body.innerHTML = orders.map((o) => {
    const isCod = o.paymentMethod === 'cod';
    const customer = o.customer
      ? `${escapeAttr(o.customer.name)}<br><span style="color:var(--muted);font-size:12px;">${escapeAttr(o.customer.phone || '')}${o.customer.email ? '<br>' + escapeAttr(o.customer.email) : ''}${o.customer.address ? '<br>' + escapeAttr(o.customer.address) : ''}</span>`
      : '—';
    const itemsText = o.items.map((i) => {
      const variantText = i.variants && Object.keys(i.variants).length
        ? ` (${Object.entries(i.variants).map(([k, v]) => `${k}: ${v}`).join(', ')})`
        : '';
      return `${escapeAttr(i.name)}${escapeAttr(variantText)} ×${i.quantity}`;
    }).join(', ');
    const currentStatus = o.fulfillmentStatus || 'Order Placed';
    const statusOptions = ORDER_STATUSES.map((s) => `<option value="${s}" ${s === currentStatus ? 'selected' : ''}>${s}</option>`).join('');
    return `
    <tr>
      <td>${o.id.slice(0, 16)}…</td>
      <td style="max-width:220px;">${itemsText}</td>
      <td>${formatMoney(o.total, ADMIN_CURRENCY)}</td>
      <td>${isCod ? 'Cash on Delivery' : 'Online (PayMongo)'}</td>
      <td>${customer}</td>
      <td>
        <select onchange="updateOrderStatus('${o.id}', this.value)" style="border:1px solid var(--line); padding:6px 8px; border-radius:2px; font-size:13px;">
          ${statusOptions}
        </select>
      </td>
      <td>
        <input type="text" value="${escapeAttr(o.trackingNumber || '')}" placeholder="Optional" style="width:110px; border:1px solid var(--line); padding:6px 8px; border-radius:2px; font-size:13px;"
          onblur="updateTrackingNumber('${o.id}', this.value)">
      </td>
      <td>${new Date(o.createdAt).toLocaleString()}</td>
    </tr>
  `;
  }).join('');
}

async function updateOrderStatus(orderId, status) {
  const res = await fetch(`/api/admin/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  if (res.ok) {
    showToast(`Order marked as "${status}"`);
  } else {
    showToast('Could not update order status');
    loadOrders();
  }
}

async function updateTrackingNumber(orderId, trackingNumber) {
  const res = await fetch(`/api/admin/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackingNumber })
  });
  if (res.ok) {
    showToast('Tracking number saved');
  } else {
    showToast('Could not save tracking number');
  }
}

boot();
