// Renders the homepage: featured grid, full catalog grid, and category filters
let ALL_PRODUCTS = [];
let ACTIVE_CATEGORY = 'All';
let SITE_CURRENCY = 'usd';

async function loadProducts() {
  const [productsRes, configRes] = await Promise.all([
    fetch('/api/products'),
    fetch('/api/config')
  ]);
  ALL_PRODUCTS = await productsRes.json();
  const config = await configRes.json();
  SITE_CURRENCY = config.currency || 'usd';
  renderFeatured();
  renderFilters();
  renderGrid();
}

function productCardHTML(p) {
  const outOfStock = p.stock <= 0;
  const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;
  const actionButton = outOfStock
    ? `<button class="btn btn-outline" disabled>Unavailable</button>`
    : hasVariants
      ? `<a href="/product.html?id=${p.id}" class="btn btn-outline">Select options</a>`
      : `<button class="btn btn-outline" onclick="addToCart('${p.id}', 1, {});event.stopPropagation();">Add to cart</button>`;
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
      <div class="product-price">${formatMoney(p.price, SITE_CURRENCY)}</div>
      ${actionButton}
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

// ---------- Homepage slideshow ----------
let slideshowIndex = 0;
let slideshowTimer = null;
let slideshowSlides = [];

async function loadSlideshow() {
  const section = document.getElementById('slideshowSection');
  if (!section) return;
  try {
    const res = await fetch('/api/slides');
    slideshowSlides = await res.json();
  } catch (e) {
    slideshowSlides = [];
  }
  if (!slideshowSlides || slideshowSlides.length === 0) return;

  section.style.display = 'block';
  const track = document.getElementById('slideshowTrack');
  const dots = document.getElementById('slideshowDots');

  track.innerHTML = slideshowSlides.map((s) => `
    <div class="slideshow-slide">
      ${s.linkUrl ? `<a href="${s.linkUrl}">` : ''}
      <img src="${s.image}" alt="${escapeHTML(s.caption || 'Promotion')}">
      ${s.caption ? `<div class="caption">${escapeHTML(s.caption)}</div>` : ''}
      ${s.linkUrl ? `</a>` : ''}
    </div>
  `).join('');

  dots.innerHTML = slideshowSlides.map((_, i) => `<span class="dot ${i === 0 ? 'active' : ''}" onclick="goToSlide(${i})"></span>`).join('');

  if (slideshowSlides.length > 1) {
    slideshowTimer = setInterval(() => goToSlide((slideshowIndex + 1) % slideshowSlides.length), 5000);
  }
}

function goToSlide(index) {
  slideshowIndex = index;
  const track = document.getElementById('slideshowTrack');
  track.style.transform = `translateX(-${index * 100}%)`;
  document.querySelectorAll('#slideshowDots .dot').forEach((d, i) => d.classList.toggle('active', i === index));
}

loadSlideshow();
