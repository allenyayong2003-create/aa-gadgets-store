# A&A Gadgets — Online Store

A minimalist, fully functional online store with:
- A public storefront (home, product pages, cart)
- An admin panel to add, edit, and delete products (with image upload)
- PayMongo integration for real online payments (card, GCash, Maya, GrabPay) — built for the Philippines
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
| `PAYMONGO_SECRET_KEY` | Your PayMongo **secret** key (starts with `sk_`). Get it free at [dashboard.paymongo.com](https://dashboard.paymongo.com/developers/api-keys). Use a `sk_test_...` key while testing. |
| `PAYMONGO_PAYMENT_METHODS` | Comma-separated list of payment methods to offer, e.g. `card,gcash,paymaya,grab_pay`. |
| `CURRENCY` | Lowercase currency code for checkout — PayMongo currently only supports `php`. |
| `SITE_URL` | The URL your store will live at (e.g. `http://localhost:3000` locally, or `https://yourstore.com` once deployed). PayMongo uses this to send customers back after paying. |

The store runs fine without a PayMongo key — the cart and admin panel all work, but the "Checkout" button will show a message explaining that online payments aren't connected yet, instead of failing silently.

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
- **Add a product** — click "+ Add product", fill in name, category, price, stock, and a description, then upload up to 6 photos and/or paste image URLs (one per line).
  - **Options (variants)** — if a product comes in different colors, sizes, etc., type them into the "Options" box, one group per line, like: `Color: Black, White, Blue` and `Size: S, M, L`. Customers will see dropdowns for each on the product page. Leave it blank for simple products with no options. Note: stock is tracked for the whole product, not separately per option.
  - **Photo per option** — if you want the product photo to switch when a customer picks a specific option (e.g. a different photo per color), list them in "Photo per option" as `OptionName: image URL`, one per line.
  - **Sold count** — the Products table shows a running "Sold" total per product. It counts up automatically the moment an order for that product is marked **Delivered** (not just placed), so it reflects completed sales.
- **Edit a product** — click "Edit" next to any row. When editing photos, check "Add these to the existing photos" if you want to add more without removing the current ones.
- **Delete a product** — click "Delete" (there's a confirmation before it deletes).
- **Moderate reviews** — click "Reviews" in the sidebar to see every review left across your whole catalog, with a Delete button for anything inappropriate. Reviews publish immediately when a customer submits them — there's no approval step by default.
- **Manage the homepage slideshow** — click "Slideshow" in the sidebar to add, edit, reorder, or delete the rotating promotional banners shown at the top of your homepage. Each slide can have a photo, an optional caption, an optional link (e.g. straight to a product or sale page), and a display order.
- **See and manage orders** — click "Orders" in the sidebar. Each order shows its items (with any chosen options), payment method, and customer/delivery details. Use the **Status** dropdown to move an order through its lifecycle: Order Placed → Processing → Shipped → Out for Delivery → Delivered (or Cancelled). You can also fill in a **Tracking #** if you're using a courier.

Stock automatically goes down by the right amount the moment a customer places an order (whether paid online or Cash on Delivery), so you can't accidentally oversell.

Changes show up on the live storefront immediately — no restart needed.

## 5. Letting customers track their orders

Every customer gets an Order ID after checkout (shown on the confirmation page). They can enter that ID plus the phone number or email they checked out with at `/track-order.html` to see a visual status timeline, their items, and any tracking number you've added.

### Optional: email customers automatically when status changes

If you'd like customers to get an email the moment you update their order status, add SMTP settings to your `.env` file. A simple option is a Gmail account with an "App Password":

1. In your Google Account, turn on 2-Step Verification, then create an "App Password" (search Google for "Gmail app password" for current steps).
2. In `.env`, set:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=youremail@gmail.com
   SMTP_PASS=your-16-character-app-password
   SMTP_FROM=youremail@gmail.com
   ```
3. Restart the server. From now on, whenever you change an order's status in the admin panel, the customer (if they gave an email) gets an email automatically.

This is entirely optional — the Track My Order page works with or without it.

## 6. Connecting PayMongo for real online payments

PayMongo is the standard payment gateway for Philippine businesses (Stripe doesn't operate here directly) — it supports cards, GCash, Maya, and GrabPay through one hosted checkout page.

1. Create a free account at [paymongo.com](https://www.paymongo.com). You'll need to submit some business details before you can accept live payments, but **test mode works immediately** with no approval needed.
2. In the PayMongo dashboard, go to Developers → API Keys and grab your **test** secret key (starts with `sk_test_`). Put it in `.env` as `PAYMONGO_SECRET_KEY`.
3. Restart the server (`npm start`). The cart page will now say online payment is connected, and "Checkout securely" will redirect to a real PayMongo checkout page offering whichever methods you listed in `PAYMONGO_PAYMENT_METHODS`.
4. Test a purchase using [PayMongo's test card numbers](https://developers.paymongo.com/docs/testing) — e.g. card number `4343 4343 4343 4345`, any future expiry date, any CVC. GCash and Maya also have test flows in test mode.
5. When PayMongo approves your business for live payments, switch to your **live** secret key (starts with `sk_live_`) in `.env`.

Orders appear in the admin Orders tab as soon as a customer starts checkout, and flip from "pending" to "paid" once PayMongo confirms the payment (checked automatically when the customer returns to the confirmation page).

## 7. Deploying it live

This is a normal Node.js app, so it deploys to any Node host — Railway, Render, Fly.io, a VPS, etc. In short:
1. Push this folder to a Git repository.
2. Deploy it on your host of choice, setting the same environment variables from `.env` in the host's dashboard (never commit your real `.env` file).
3. Set `SITE_URL` to your real domain once you have one, so PayMongo redirects customers back correctly after payment.
4. Point your domain at the host, and you're live.

If you'd like help with a specific host (Railway, Render, etc.), just ask — the steps differ slightly between them.

## Project structure

```
server.js              Backend: product API, admin auth, PayMongo checkout
data/db.json            Your product catalog, orders, and slideshow (plain JSON file)
data/uploads/           Uploaded product photos and slideshow images (persistent volume)
public/
  index.html             Storefront home page (includes the slideshow banner)
  product.html           Single product page (photo gallery + reviews)
  cart.html              Cart + checkout
  success.html           Order confirmation page
  track-order.html       Public order-status lookup page
  admin.html             Admin login + dashboard
  css/style.css          All styling (minimalist white theme)
  js/store.js            Storefront product rendering + slideshow
  js/cart.js             Shared cart logic (localStorage)
  js/admin.js            Admin panel logic
  images/                Logo and default placeholder photos
```

## Notes on the current setup

- **Storage:** products, orders, and slideshow data live in a single JSON file for simplicity. This is fine for a small catalog; if you outgrow it, the logic in `server.js` can be swapped for a real database (Postgres, MongoDB, etc.) without changing the frontend.
- **Security:** admin login is a single shared username/password. For a bigger team, this would be worth upgrading to per-person accounts.
- **Images:** uploaded product and slideshow photos are saved to `data/uploads/` — this is set up to live on your host's persistent volume so it survives redeploys. Back up the whole `data/` folder if you move servers.
- **Reviews:** publish immediately with no approval step. If review spam becomes an issue, the review-submission endpoint in `server.js` is the place to add moderation-before-publish.
- **Variant stock:** stock is tracked per product, not per individual option combination (e.g., you can't set "5 in Black, 10 in White" separately) — it's one shared stock count for the whole product regardless of which options a customer picks.
