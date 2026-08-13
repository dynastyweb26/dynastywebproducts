// Vercel Node serverless function. Creates a Stripe Checkout Session.
//
// Security contract: the client sends only a product id and a configuration.
// The client never sends a price. This function looks the product up in
// products.json, validates the configuration, and computes every amount
// server-side. Any request carrying a price-like field is rejected outright.

const Stripe = require('stripe');
const { z } = require('zod');
const catalog = require('../products.json');

// Force the Node runtime (Stripe SDK is not Edge-compatible).
const config = { runtime: 'nodejs' };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Rate limiting (Upstash Redis). Constructed only when credentials are
// present, so the function fails open where Upstash is not configured - an
// unconfigured limiter must never block checkout.
const { Ratelimit } = require('@upstash/ratelimit');
const { Redis } = require('@upstash/redis');

let ratelimit = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  ratelimit = new Ratelimit({
    redis: new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    }),
    // 10 checkout sessions per minute per IP is well above any real buyer.
    limiter: Ratelimit.fixedWindow(10, '60 s'),
    prefix: 'checkout',
    analytics: false,
  });
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || 'unknown';
}

// Single source of truth. Throws on unknown ids so a bad id can never fall
// through to a zero-amount charge.
function getProduct(id) {
  const product = catalog.products.find((p) => p.id === id);
  if (!product) {
    throw new ProductNotFoundError(id);
  }
  return product;
}

class ProductNotFoundError extends Error {
  constructor(id) {
    super(`Unknown product id: ${id}`);
    this.name = 'ProductNotFoundError';
  }
}

// Any of these keys anywhere in the body means the client tried to set a
// price. Reject rather than ignore, so tampering is a visible failure.
const FORBIDDEN_KEYS = new Set([
  'price',
  'prices',
  'priceId',
  'price_id',
  'amount',
  'amount_total',
  'amounttotal',
  'unitamount',
  'unit_amount',
  'total',
  'subtotal',
  'lineamount',
  'line_amount',
]);

function containsForbiddenKey(value) {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenKey);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).some(
      (key) => FORBIDDEN_KEYS.has(key.toLowerCase()) || containsForbiddenKey(value[key])
    );
  }
  return false;
}

// A single house-number sign: 1 to 6 alphanumeric characters. Uppercased
// before validation so a raw API caller sending lowercase is normalized, not
// silently priced on a different string than what appears on the sign.
const signLineSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => /^[A-Z0-9]{1,6}$/.test(s), {
    message: 'Each sign must be 1 to 6 letters or numbers, no spaces.',
  });

function perCharacterSchema(product) {
  return z.object({
    productId: z.literal(product.id),
    lines: z
      .array(signLineSchema)
      .min(1, { message: 'Enter at least one sign.' })
      .max(product.pricing.maxLines, {
        message: `A single order can have at most ${product.pricing.maxLines} signs.`,
      }),
  });
}

function flatSchema(product) {
  return z.object({
    productId: z.literal(product.id),
    quantity: z
      .number()
      .int({ message: 'Quantity must be a whole number.' })
      .min(1, { message: 'Quantity must be at least 1.' })
      .max(product.pricing.maxQuantity, {
        message: `Quantity cannot exceed ${product.pricing.maxQuantity}.`,
      }),
  });
}

// Returns { lineItems, metadata }. Amounts are computed here and nowhere else.
function buildOrder(product, body) {
  if (product.pricing.model === 'per-character') {
    const { lines } = perCharacterSchema(product).parse(body);
    const lineItems = lines.map((line) => ({
      quantity: 1,
      price_data: {
        currency: catalog.currency,
        // e.g. "Modern LED House Numbers — 4524" so fulfillment reads the
        // Stripe row directly with no cross-referencing.
        product_data: { name: `${product.name} — ${line}` },
        unit_amount: line.length * product.pricing.unitAmount,
      },
    }));
    return { lineItems, metadata: { productId: product.id, lines: JSON.stringify(lines) } };
  }

  if (product.pricing.model === 'flat') {
    const { quantity } = flatSchema(product).parse(body);
    const lineItems = [
      {
        quantity,
        price_data: {
          currency: catalog.currency,
          product_data: { name: product.name },
          unit_amount: product.pricing.unitAmount,
        },
      },
    ];
    return { lineItems, metadata: { productId: product.id, quantity: String(quantity) } };
  }

  // Discriminated union guard: a new pricing model must be handled explicitly.
  throw new Error(`Unhandled pricing model: ${product.pricing.model}`);
}

function resolveSiteUrl() {
  if (process.env.SITE_URL) {
    return process.env.SITE_URL.replace(/\/+$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // Rate limit by client IP. Fails open on limiter errors so an Upstash
  // outage cannot take checkout down; only an explicit over-limit blocks.
  if (ratelimit) {
    try {
      const { success } = await ratelimit.limit(getClientIp(req));
      if (!success) {
        return res
          .status(429)
          .json({ error: 'Too many requests. Please wait a moment and try again.' });
      }
    } catch (err) {
      console.error('Rate limiter error (failing open):', err);
    }
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};

    if (containsForbiddenKey(body)) {
      return res.status(400).json({
        error: 'Price fields are not accepted. The server sets the price.',
      });
    }

    if (typeof body.productId !== 'string' || body.productId.length === 0) {
      return res.status(400).json({ error: 'A productId is required.' });
    }

    let product;
    try {
      product = getProduct(body.productId);
    } catch (err) {
      if (err instanceof ProductNotFoundError) {
        return res.status(400).json({ error: 'Unknown product.' });
      }
      throw err;
    }

    let order;
    try {
      order = buildOrder(product, body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: err.issues[0].message });
      }
      throw err;
    }

    const siteUrl = resolveSiteUrl();
    if (!siteUrl) {
      // Configuration error, not a client error. Do not leak specifics.
      console.error('SITE_URL is not set and VERCEL_URL is unavailable.');
      return res.status(500).json({ error: 'Unable to start checkout. Please try again.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: order.lineItems,
      shipping_address_collection: { allowed_countries: ['US'] },
      // Prices already absorb shipping. A single zero-cost option makes Stripe
      // display "Free shipping" rather than no shipping line at all.
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 0, currency: catalog.currency },
            display_name: 'Free shipping',
          },
        },
      ],
      phone_number_collection: { enabled: true },
      custom_text: { submit: { message: catalog.shipWindow } },
      metadata: order.metadata,
      success_url: `${siteUrl}/order/confirmed.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/order/canceled.html`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    // Log the real error server-side; return a generic message to the client.
    console.error('Checkout session creation failed:', err);
    return res.status(500).json({ error: 'Unable to start checkout. Please try again.' });
  }
};

module.exports.config = config;
