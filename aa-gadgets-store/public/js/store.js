// Renders the homepage: featured grid, full catalog grid, and category filters
let ALL_PRODUCTS = [];
let ACTIVE_CATEGORY = 'All';

async function loadProducts() {
  const res = await fetch('/api/products');
  ALL_PRODUCTS = await res.json();
  renderFeatured();
  renderFilters();
  renderGrid();
}

function productCardHTML(p) {
  const outOfStock = p.stock <= 0;
  return `
    <div class="product-card">
      <a href="/product.html?id=${p.id}">
        <div class="product-thumb">
          ${outOfStock ? '<span class="stock-tag">Sold out</span>' : (p.stock <= 5 ? '<span class="stock-tag">Low stock</span>' : '')}
          <img src="${p.image}" alt="${escapeHTML(p.name)}" loading="lazy">
        </div>
      </a>
      <span class="product-category">${escapeHTML(p.category)}</span>
      <a href="/product.html?id=${p.id}"><div class="product-name">${escapeHTML(p.name)}</div></a>
      <div class="product-price">${formatMoney(p.price)}</div>
      <button class="btn btn-outline" ${outOfStock ? 'disabled' : ''} onclick="addToCart('${p.id}');event.stopPropagation();">
        ${outOfStock ? 'Unavailable' : 'Add to cart'}
      </button>
    </div>
  `;
}

function renderFeatured() {
  const grid = document.getElementById('featuredGrid');
  if (!grid) return;
  const featured = ALL_PRODUCTS.filter((p) => p.featured);
  grid.innerHTML = featured.length
    ? featured.map(productCardHTML).join('')
    : '<div class="empty-state">Nothing featured yet — check back soon.</div>';
}

function renderFilters() {
  const wrap = document.getElementById('filterChips');
  if (!wrap) return;
  const categories = ['All', ...new Set(ALL_PRODUCTS.map((p) => p.category))];
  wrap.innerHTML = categories
    .map((c) => `<button class="chip ${c === ACTIVE_CATEGORY ? 'active' : ''}" data-category="${escapeHTML(c)}">${escapeHTML(c)}</button>`)
    .join('');
  wrap.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      ACTIVE_CATEGORY = chip.dataset.category;
      renderFilters();
      renderGrid();
    });
  });
}

function renderGrid() {
  const grid = document.getElementById('allGrid');
  if (!grid) return;
  const list = ACTIVE_CATEGORY === 'All' ? ALL_PRODUCTS : ALL_PRODUCTS.filter((p) => p.category === ACTIVE_CATEGORY);
  grid.innerHTML = list.length
    ? list.map(productCardHTML).join('')
    : '<div class="empty-state">No products in this category yet.</div>';
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

if (document.getElementById('featuredGrid') || document.getElementById('allGrid')) {
  loadProducts();
}
