# A&A Gadgets — Online Store

A minimalist, fully functional online store with:
- A public storefront (home, product pages, cart)
- An admin panel to add, edit, and delete products (with image upload)
- Stripe Checkout integration for real online payments
- An orders list in the admin panel

Everything runs from one small Node.js server. Products and orders are stored in `data/db.json` — no external database needed.

## 1. Install

You need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
npm install
```

## 2. Configure

Copy the example environment file and fill in your own values:

```bash
cp .env.example .env
```

Open `.env` and set:

| Variable | What it's for |
|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Login for `/admin.html`. Change these from the defaults. |
| `SESSION_SECRET` | Any long random string — used to sign login sessions. |
| `STRIPE_SECRET_KEY` | Your Stripe **secret** key (starts with `sk_`). Get it free at [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys). Use a `sk_test_...` key while testing. |
| `CURRENCY` | Lowercase currency code for checkout, e.g. `usd`, `php`, `eur`. |
| `SITE_URL` | The URL your store will live at (e.g. `http://localhost:3000` locally, or `https://yourstore.com` once deployed). Stripe uses this to send customers back after paying. |

The store runs fine without a Stripe key — the cart and admin panel all work, but the "Checkout" button will show a message explaining that payments aren't connected yet, instead of failing silently.

## 3. Run it

```bash
npm start
```

Then open:
- **Storefront:** http://localhost:3000
- **Admin panel:** http://localhost:3000/admin.html

## 4. Using the admin panel

Go to `/admin.html` and sign in with the username/password from your `.env` file.

From there you can:
- **Add a product** — click "+ Add product", fill in name, category, price, stock, and a description, then either upload an image file or paste an image URL.
- **Edit a product** — click "Edit" next to any row.
- **Delete a product** — click "Delete" (there's a confirmation before it deletes).
- **See orders** — click "Orders" in the sidebar to see everything that's come through checkout, with payment status.

Changes show up on the live storefront immediately — no restart needed.

## 5. Connecting Stripe for real payments

1. Create a free account at [stripe.com](https://stripe.com).
2. In the Stripe dashboard, grab your **test** keys first (Developers → API keys). Put the secret key in `.env` as `STRIPE_SECRET_KEY`.
3. Restart the server (`npm start`). The cart page will now say payments are connected, and "Checkout securely" will redirect to a real Stripe Checkout page.
4. Test a purchase using [Stripe's test card numbers](https://docs.stripe.com/testing) — e.g. card number `4242 4242 4242 4242`, any future expiry date, any CVC.
5. When you're ready to accept real money, switch to your **live** keys in Stripe (they start with `sk_live_`) and update `.env`.

Orders appear in the admin Orders tab as soon as a customer starts checkout, and flip from "pending" to "paid" once Stripe confirms the payment.

## 6. Deploying it live

This is a normal Node.js app, so it deploys to any Node host — Railway, Render, Fly.io, a VPS, etc. In short:
1. Push this folder to a Git repository.
2. Deploy it on your host of choice, setting the same environment variables from `.env` in the host's dashboard (never commit your real `.env` file).
3. Set `SITE_URL` to your real domain once you have one, so Stripe redirects customers back correctly after payment.
4. Point your domain at the host, and you're live.

If you'd like help with a specific host (Railway, Render, etc.), just ask — the steps differ slightly between them.

## Project structure

```
server.js              Backend: product API, admin auth, Stripe checkout
data/db.json            Your product catalog and orders (plain JSON file)
public/
  index.html             Storefront home page
  product.html           Single product page
  cart.html              Cart + checkout
  success.html           Order confirmation page
  admin.html             Admin login + dashboard
  css/style.css          All styling (minimalist white theme)
  js/store.js            Storefront product rendering
  js/cart.js             Shared cart logic (localStorage)
  js/admin.js            Admin panel logic
  images/                Logo and product photos
```

## Notes on the current setup

- **Storage:** products/orders live in a single JSON file for simplicity. This is fine for a small catalog; if you outgrow it, the product/order logic in `server.js` can be swapped for a real database (Postgres, MongoDB, etc.) without changing the frontend.
- **Security:** admin login is a single shared username/password. For a bigger team, this would be worth upgrading to per-person accounts.
- **Images:** uploaded product photos are saved to `public/images/products/`. Back this folder up along with `data/db.json` if you move servers.
