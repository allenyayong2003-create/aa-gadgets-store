// Shared cart logic — cart lives in localStorage as:
// { [lineKey]: { productId, quantity, variants: { "Color": "Black", "Size": "M" } } }
// lineKey combines the product id and its chosen variants, so the same product
// with different options (e.g. two colors) shows as separate cart lines.
const CART_KEY = 'aa_gadgets_cart';

function makeLineKey(productId, variants = {}) {
  const sortedEntries = Object.entries(variants || {}).sort(([a], [b]) => a.localeCompare(b));
  return `${productId}::${JSON.stringify(sortedEntries)}`;
}

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartBadge();
}

function addToCart(productId, quantity = 1, variants = {}) {
  const cart = getCart();
  const lineKey = makeLineKey(productId, variants);
  if (cart[lineKey]) {
    cart[lineKey].quantity += quantity;
  } else {
    cart[lineKey] = { productId, quantity, variants: variants || {} };
  }
  saveCart(cart);
  showToast('Added to cart');
}

function setQuantity(lineKey, quantity) {
  const cart = getCart();
  if (!cart[lineKey]) return;
  if (quantity <= 0) {
    delete cart[lineKey];
  } else {
    cart[lineKey].quantity = quantity;
  }
  saveCart(cart);
}

function removeFromCart(lineKey) {
  const cart = getCart();
  delete cart[lineKey];
  saveCart(cart);
}

function clearCart() {
  localStorage.removeItem(CART_KEY);
  updateCartBadge();
}

function cartItemCount() {
  const cart = getCart();
  return Object.values(cart).reduce((sum, line) => sum + line.quantity, 0);
}

function updateCartBadge() {
  const badge = document.getElementById('cartCount');
  if (!badge) return;
  const count = cartItemCount();
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function showToast(message) {
  let toast = document.getElementById('globalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'globalToast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function formatMoney(amount, currency = 'usd') {
  const symbols = { usd: '$', eur: '€', gbp: '£', php: '₱' };
  const symbol = symbols[currency] || '';
  return `${symbol}${Number(amount).toFixed(2)}`;
}

document.addEventListener('DOMContentLoaded', updateCartBadge);
