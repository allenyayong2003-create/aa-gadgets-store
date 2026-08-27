// Shared cart logic — cart lives in localStorage as { [productId]: quantity }
const CART_KEY = 'aa_gadgets_cart';

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

function addToCart(productId, quantity = 1) {
  const cart = getCart();
  cart[productId] = (cart[productId] || 0) + quantity;
  saveCart(cart);
  showToast('Added to cart');
}

function setQuantity(productId, quantity) {
  const cart = getCart();
  if (quantity <= 0) {
    delete cart[productId];
  } else {
    cart[productId] = quantity;
  }
  saveCart(cart);
}

function removeFromCart(productId) {
  const cart = getCart();
  delete cart[productId];
  saveCart(cart);
}

function clearCart() {
  localStorage.removeItem(CART_KEY);
  updateCartBadge();
}

function cartItemCount() {
  const cart = getCart();
  return Object.values(cart).reduce((sum, q) => sum + q, 0);
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
