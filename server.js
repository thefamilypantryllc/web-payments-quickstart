require('dotenv').config();
// micro provides http helpers
const { json, send } = require('micro');
// microrouter provides http server routing
const { router, get, post } = require('microrouter');
// serve-handler serves static assets
const staticHandler = require('serve-handler');
// async-retry will retry failed API requests
const retry = require('async-retry');

// logger gives us insight into what's happening
const logger = require('./server/logger');
// square provides the API client and error types
const { client: square } = require('./server/square');

require('./database/init');
const saveOrder = require('./database/saveOrder');
const {
  clearSessionCookie,
  getSession,
  requestLoginCode,
  requireSession,
  setSessionCookie,
  verifyLoginCode,
} = require('./customer-auth');

const fs = require('fs');
const path = require('path');

async function adminPage(req, res) {
  const html = fs.readFileSync(
    path.join(__dirname, 'public', 'admin.html'),
    'utf8',
  );

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  return send(res, 200, html);
}

function validateDeliveryTime(deliveryTime) {
  if (!deliveryTime) {
    return 'Please choose a delivery time.';
  }

  const selectedTime = new Date(deliveryTime);

  if (Number.isNaN(selectedTime.getTime())) {
    return 'Please choose a valid delivery time.';
  }

  const minimumDeliveryTime = Date.now() + 24 * 60 * 60 * 1000;

  if (selectedTime.getTime() < minimumDeliveryTime) {
    return 'Delivery time must be at least 24 hours from now.';
  }

  return null;
}

async function createPayment(req, res) {
  const payload = await json(req);
  const customerSession = getSession(req);

  if (!payload.items || payload.items.length === 0) {
    return send(res, 400, {
      success: false,
      error: 'Your cart is empty. Please add at least one item.',
    });
  }

  const deliveryTimeError = validateDeliveryTime(payload.deliveryTime);

  if (deliveryTimeError) {
    return send(res, 400, {
      success: false,
      error: deliveryTimeError,
    });
  }
  if (payload.lat && payload.lon) {
    const validationResponse = await fetch(
      'http://localhost:3000/validate-address',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: payload.lat, lon: payload.lon }),
      },
    );

    const check = await validationResponse.json();

    if (!check.allowed) {
      return send(res, 400, {
        success: false,
        error: `Address is outside delivery area (${check.miles.toFixed(1)} miles).`,
      });
    }
  }

  let paymentSourceId = payload.sourceId;

  if (payload.savedCardId) {
    if (!customerSession) {
      return send(res, 401, {
        success: false,
        error: 'Please sign in again to use a saved card.',
      });
    }

    const cardResponse = await square.cards.get({
      cardId: payload.savedCardId,
    });
    const savedCard = cardResponse.card || cardResponse.result?.card;

    if (
      !savedCard ||
      savedCard.customerId !== customerSession.square_customer_id ||
      savedCard.enabled === false
    ) {
      return send(res, 403, {
        success: false,
        error: 'That saved card is not available for this account.',
      });
    }

    paymentSourceId = savedCard.id;
  }

  console.log('CARD PAYMENT PAYLOAD:');
  console.dir(payload, { depth: null });

  logger.debug(JSON.stringify(payload));

  await retry(async (bail, attempt) => {
    try {
      logger.debug('Creating payment', { attempt });

      const orderResponse = await square.orders.create({
        idempotencyKey: crypto.randomUUID(),
        order: {
          locationId: payload.locationId,
          lineItems: payload.items.map((item) => ({
            catalogObjectId: item.catalogObjectId,
            quantity: item.quantity,
          })),
        },
      });

      console.log('FULL ORDER RESPONSE');
      console.dir(orderResponse, { depth: null });

      const order = orderResponse.result?.order || orderResponse.order;

      const subtotal = Number(order.totalMoney.amount) / 100;
      const deliveryFee = subtotal < 40 ? 3.0 : 0;
      const salesTax = subtotal * 0.08225;
      const tipAmount = subtotal * ((payload.tipPercent || 0) / 100);
      const grandTotal = subtotal + deliveryFee + salesTax + tipAmount;
      const paymentMethod = ['Apple Pay', 'Google Pay'].includes(
        payload.paymentMethod,
      )
        ? payload.paymentMethod
        : 'Card';

      console.log('CARD ORDER CREATED:');
      console.dir(order, { depth: null });
      console.log('BEFORE saveOrder');

      const orderNumber = saveOrder({
        squareOrderId: order.id,
        customerName: `${payload.firstName} ${payload.lastName}`,
        phone: payload.phone,
        email: payload.email,
        address: payload.address,
        deliveryTime: payload.deliveryTime,
        paymentMethod,
        status: 'Paid',
        subtotal,
        deliveryFee,
        salesTax,
        tip: tipAmount,
        total: grandTotal,
      });

      console.log('AFTER saveOrder');
      console.log('ORDER NUMBER:', orderNumber);

      // Send Power Automate notification
      try {
        await fetch(process.env.POWER_AUTOMATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderNumber: String(orderNumber),
            firstName: payload.firstName,
            lastName: payload.lastName,
            email: payload.email,
            phone: payload.phone,
            address: payload.address,
            deliveryTime: payload.deliveryTime,
            paymentMethod,
            subtotal,
            deliveryFee,
            salesTax,
            tip: tipAmount,
            grandTotal,
            items: (order.lineItems || []).map(
              (i) => `${i.name} (${i.variationName}) x${i.quantity}`,
            ),
          }),
        });
        console.log('Power Automate notification sent');
      } catch (err) {
        console.error('Power Automate notification failed:', err);
      }

      const payment = {
        idempotencyKey: payload.idempotencyKey,
        locationId: payload.locationId,
        sourceId: paymentSourceId,
        amountMoney: {
          amount: BigInt(Math.round(grandTotal * 100)),
          currency: 'USD',
        },
      };

      if (customerSession?.square_customer_id) {
        payment.customerId = customerSession.square_customer_id;
      }

      console.log('PAYMENT AMOUNT:', BigInt(Math.round(grandTotal * 100)));

      if (payload.customerId) {
        payment.customerId = payload.customerId;
      }

      if (payload.verificationToken) {
        payment.verificationToken = payload.verificationToken;
      }

      const { payment: paymentResponse } =
        await square.payments.create(payment);

      logger.info('Payment succeeded!', { paymentResponse });

      return send(res, 200, {
        success: true,
        orderNumber,
        payment: {
          id: paymentResponse.id,
          status: paymentResponse.status,
          receiptUrl: paymentResponse.receiptUrl,
        },
        status: 'PAID',
        subtotal,
        deliveryFee,
        salesTax,
        tipAmount,
        grandTotal,
        items: (order.lineItems || []).map((item) => ({
          name: item.name,
          variationName: item.variationName,
          quantity: item.quantity,
        })),
      });
    } catch (ex) {
      if (ex.errors) {
        logger.error(ex.errors);
        bail(ex);
      } else {
        logger.error(`Error creating payment on attempt ${attempt}: ${ex}`);
        throw ex;
      }
    }
  });
}

async function storeCard(req, res) {
  try {
    const customer = requireSession(req);
    const payload = await json(req);

    if (!payload.sourceId || payload.consent !== true) {
      return send(res, 400, {
        success: false,
        error: 'Card-saving consent and a valid payment token are required.',
      });
    }

    const response = await square.cards.create({
      idempotencyKey: crypto.randomUUID(),
      sourceId: payload.sourceId,
      card: {
        customerId: customer.square_customer_id,
      },
    });
    const card = response.card || response.result?.card;

    return send(res, 200, {
      success: true,
      card: serializeCard(card),
    });
  } catch (err) {
    console.error('STORE CARD ERROR:', err);
    return send(res, err.statusCode || 500, {
      success: false,
      error: err.message || 'Unable to save this card.',
    });
  }
}

async function createCashOrder(req, res) {
  const payload = await json(req);

  if (!payload.items || payload.items.length === 0) {
    return send(res, 400, {
      success: false,
      error: 'Your cart is empty. Please add at least one item.',
    });
  }

  const deliveryTimeError = validateDeliveryTime(payload.deliveryTime);

  if (deliveryTimeError) {
    return send(res, 400, {
      success: false,
      error: deliveryTimeError,
    });
  }
  if (payload.lat && payload.lon) {
    const validationResponse = await fetch(
      'http://localhost:3000/validate-address',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: payload.lat, lon: payload.lon }),
      },
    );

    const check = await validationResponse.json();

    if (!check.allowed) {
      return send(res, 400, {
        success: false,
        error: `Address is outside delivery area (${check.miles.toFixed(1)} miles).`,
      });
    }
  }

  try {
    logger.info('Creating cash order', payload);

    console.log('STEP 1');
    console.log('ITEMS RECEIVED:');
    console.dir(payload.items, { depth: null });

    const response = await square.orders.create({
      idempotencyKey: payload.idempotencyKey,
      order: {
        locationId: payload.locationId,
        lineItems: (payload.items || []).map((item) => ({
          catalogObjectId: item.catalogObjectId,
          quantity: item.quantity,
        })),
      },
    });

    console.log('STEP 2');
    console.log('RESPONSE.ORDER');
    console.dir(response.order, { depth: null });

    const order = response.result?.order || response.order;

    if (!order) {
      console.error('NO ORDER RETURNED');
      console.dir(response, { depth: null });
      return send(res, 500, {
        success: false,
        error: 'Square did not return an order',
      });
    }

    const subtotal = Number(order.totalMoney.amount) / 100;
    const deliveryFee = subtotal < 40 ? 3.0 : 0;
    const salesTax = Math.round(subtotal * 0.08225 * 100) / 100;
    const tipAmount =
      Math.round(subtotal * ((payload.tipPercent || 0) / 100) * 100) / 100;
    const grandTotal = subtotal + deliveryFee + salesTax + tipAmount;

    console.log('SUBTOTAL:', subtotal);
    console.log('DELIVERY:', deliveryFee);
    console.log('TAX:', salesTax);
    console.log('TIP:', tipAmount);
    console.log('GRAND TOTAL:', grandTotal);

    console.log('FINAL CASH ORDER:');
    console.dir(order, { depth: null });
    console.log('BEFORE saveOrder');

    const orderNumber = saveOrder({
      squareOrderId: order.id,
      customerName: `${payload.firstName} ${payload.lastName}`,
      phone: payload.phone,
      email: payload.email,
      address: payload.address,
      deliveryTime: payload.deliveryTime,
      paymentMethod: 'Cash',
      status: 'Received',
      subtotal,
      deliveryFee,
      salesTax,
      tip: tipAmount,
      total: grandTotal,
    });

    console.log('AFTER saveOrder');
    console.log('ORDER NUMBER:', orderNumber);

    // Send Power Automate notification
    try {
      await fetch(process.env.POWER_AUTOMATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNumber: String(orderNumber),
          firstName: payload.firstName,
          lastName: payload.lastName,
          email: payload.email,
          phone: payload.phone,
          address: payload.address,
          deliveryTime: payload.deliveryTime,
          paymentMethod: 'Cash',
          subtotal,
          deliveryFee,
          salesTax,
          tip: tipAmount,
          grandTotal,
          items: (order.lineItems || []).map(
            (i) => `${i.name} (${i.variationName}) x${i.quantity}`,
          ),
        }),
      });
      console.log('Power Automate notification sent');
    } catch (err) {
      console.error('Power Automate notification failed:', err);
    }

    return send(res, 200, {
      success: true,
      orderNumber,
      status: 'OPEN',
      subtotal,
      deliveryFee,
      salesTax,
      tipAmount,
      grandTotal,
      items: (order.lineItems || []).map((item) => ({
        name: item.name,
        variationName: item.variationName,
        quantity: item.quantity,
      })),
    });
  } catch (err) {
    console.error('CASH ERROR:', err);
    return send(res, 500, {
      success: false,
      error: err.message,
    });
  }
}

async function getCatalog(req, res) {
  try {
    const response = await square.catalog.list();
    console.dir(response, { depth: null });
    return send(res, 200, { success: true });
  } catch (err) {
    console.error('CATALOG ERROR:', err);
    return send(res, 500, { success: false, error: err.message });
  }
}

async function addressSearch(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const query = url.searchParams.get('q');

    const response = await fetch(
      `https://atlas.microsoft.com/search/address/json` +
        `?api-version=1.0` +
        `&subscription-key=${process.env.AZURE_MAPS_KEY}` +
        `&query=${encodeURIComponent(query)}` +
        `&countrySet=US` +
        `&lat=39.5663` +
        `&lon=-94.4485` +
        `&radius=25000`,
    );

    const data = await response.json();
    return send(res, 200, data);
  } catch (err) {
    console.error('ADDRESS SEARCH ERROR:', err);
    return send(res, 500, { error: err.message });
  }
}

async function validateDeliveryAddress(req, res) {
  try {
    const payload = await json(req);

    const customerLat = payload.lat;
    const customerLon = payload.lon;

    const STORE_LAT = 39.5663;
    const STORE_LON = -94.4485;

    const response = await fetch(
      `https://atlas.microsoft.com/route/directions/json` +
        `?api-version=1.0` +
        `&subscription-key=${process.env.AZURE_MAPS_KEY}` +
        `&query=${STORE_LAT},${STORE_LON}:${customerLat},${customerLon}`,
    );

    const data = await response.json();
    const meters = data.routes?.[0]?.summary?.lengthInMeters || 0;
    const miles = meters * 0.000621371;

    return send(res, 200, { allowed: miles <= 15, miles });
  } catch (err) {
    console.error(err);
    return send(res, 500, { allowed: false, error: err.message });
  }
}

async function cartSummary(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const items = JSON.parse(decodeURIComponent(url.searchParams.get('items')));

  const response = await square.orders.create({
    idempotencyKey: crypto.randomUUID(),
    order: {
      locationId: process.env.SQUARE_LOCATION_ID,
      lineItems: items.map((item) => ({
        catalogObjectId: item.catalogObjectId,
        quantity: item.quantity,
      })),
    },
  });

  const order = response.result?.order || response.order;

  if (!order) {
    return send(res, 500, { error: 'Square did not return an order' });
  }

  if (!order.lineItems) {
    return send(res, 500, { error: 'Order returned with no line items' });
  }

  return send(res, 200, {
    items: order.lineItems.map((item) => ({
      name: item.name,
      variationName: item.variationName,
      quantity: item.quantity,
      totalPrice: Number(item.totalMoney.amount) / 100,
    })),
    subtotal: Number(order.totalMoney.amount) / 100,
  });
}

async function serveStatic(req, res) {
  logger.debug('Handling request', req.path);
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://web.squarecdn.com https://atlas.microsoft.com",
      "style-src 'self' 'unsafe-inline' https://atlas.microsoft.com",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://pci-connect.squareup.com https://*.squareup.com https://*.squarecdn.com https://atlas.microsoft.com https://*.atlas.microsoft.com",
      "frame-src 'self' https://*.squareup.com https://*.squarecdn.com https://pay.google.com https://applepay.cdn-apple.com",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  await staticHandler(req, res, { public: 'public' });
}

async function getSquareConfig(req, res) {
  const applicationId = process.env.SQUARE_APPLICATION_ID;
  const locationId = process.env.SQUARE_LOCATION_ID;

  if (!applicationId || !locationId) {
    return send(res, 500, {
      success: false,
      error: 'Square production configuration is incomplete.',
    });
  }

  return send(res, 200, {
    success: true,
    applicationId,
    locationId,
    environment:
      String(process.env.SQUARE_ENVIRONMENT).toLowerCase() === 'sandbox'
        ? 'sandbox'
        : 'production',
  });
}

function serializeCard(card) {
  if (!card) return null;

  return {
    id: card.id,
    brand: card.cardBrand || 'Card',
    last4: card.last4,
    expMonth: Number(card.expMonth),
    expYear: Number(card.expYear),
  };
}

async function requestCustomerCode(req, res) {
  try {
    const { email } = await json(req);
    await requestLoginCode(email);
    return send(res, 200, {
      success: true,
      message: 'Check your email for a six-digit sign-in code.',
    });
  } catch (err) {
    console.error('REQUEST LOGIN CODE ERROR:', err);
    return send(res, err.statusCode || 500, {
      success: false,
      error:
        err.statusCode && err.statusCode < 500
          ? err.message
          : 'Email sign-in is temporarily unavailable.',
    });
  }
}

async function verifyCustomerCode(req, res) {
  try {
    const { email, code } = await json(req);
    const result = await verifyLoginCode(email, code);
    setSessionCookie(req, res, result.token);
    return send(res, 200, {
      success: true,
      customer: {
        email: result.customer.email,
      },
    });
  } catch (err) {
    return send(res, err.statusCode || 500, {
      success: false,
      error: err.message || 'Unable to verify this code.',
    });
  }
}

async function getCustomerSession(req, res) {
  const customer = getSession(req);

  if (!customer) {
    return send(res, 200, { loggedIn: false });
  }

  return send(res, 200, {
    loggedIn: true,
    customer: {
      email: customer.email,
    },
  });
}

async function logoutCustomer(req, res) {
  const customer = getSession(req);

  if (customer) {
    const db = require('./database/db');
    db.prepare('DELETE FROM customer_sessions WHERE id = ?').run(
      customer.session_id,
    );
  }

  clearSessionCookie(res);
  return send(res, 200, { success: true });
}

async function listCustomerCards(req, res) {
  try {
    const customer = requireSession(req);
    const page = await square.cards.list({
      customerId: customer.square_customer_id,
      includeDisabled: false,
    });
    const cards = [];

    for await (const card of page) {
      if (card.enabled !== false) cards.push(serializeCard(card));
    }

    return send(res, 200, { success: true, cards });
  } catch (err) {
    return send(res, err.statusCode || 500, {
      success: false,
      error: err.message || 'Unable to load saved cards.',
    });
  }
}

async function removeCustomerCard(req, res) {
  try {
    const customer = requireSession(req);
    const { cardId } = await json(req);
    const response = await square.cards.get({ cardId });
    const card = response.card || response.result?.card;

    if (!card || card.customerId !== customer.square_customer_id) {
      return send(res, 404, {
        success: false,
        error: 'Saved card not found.',
      });
    }

    await square.cards.disable({ cardId });
    return send(res, 200, { success: true });
  } catch (err) {
    return send(res, err.statusCode || 500, {
      success: false,
      error: err.message || 'Unable to remove this card.',
    });
  }
}

async function getAdminOrders(req, res) {
  try {
    const db = require('./database/db');
    const orders = db
      .prepare('SELECT * FROM orders ORDER BY created_at DESC')
      .all();
    return send(res, 200, orders);
  } catch (err) {
    console.error('ADMIN ORDERS ERROR:', err);
    return send(res, 500, { error: err.message });
  }
}

async function getOrderStatus(req, res) {
  try {
    const payload = await json(req);
    const orderNumber = String(payload.orderNumber || '').trim();
    const email = String(payload.email || '')
      .trim()
      .toLowerCase();

    if (!orderNumber || !email) {
      return send(res, 400, {
        success: false,
        error: 'Please enter your order number and email address.',
      });
    }

    const db = require('./database/db');
    const order = db
      .prepare(
        `
          SELECT
            order_number,
            customer_name,
            delivery_time,
            payment_method,
            status,
            total,
            created_at
          FROM orders
          WHERE LOWER(order_number) = LOWER(?)
            AND LOWER(email) = ?
        `,
      )
      .get(orderNumber, email);

    if (!order) {
      return send(res, 404, {
        success: false,
        error: 'We could not find an order matching those details.',
      });
    }

    return send(res, 200, {
      success: true,
      order: {
        orderNumber: order.order_number,
        customerName: order.customer_name,
        deliveryTime: order.delivery_time,
        paymentMethod: order.payment_method,
        status: order.status === 'Recieved' ? 'Received' : order.status,
        total: Number(order.total || 0),
        createdAt: order.created_at,
      },
    });
  } catch (err) {
    console.error('ORDER STATUS ERROR:', err);
    return send(res, 500, {
      success: false,
      error: 'Order tracking is temporarily unavailable.',
    });
  }
}

async function updateOrderStatus(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/');
    const id = parts[3];
    const { status } = await json(req);
    const db = require('./database/db');
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
    return send(res, 200, { success: true });
  } catch (err) {
    console.error('UPDATE STATUS ERROR:', err);
    return send(res, 500, { error: err.message });
  }
}
async function bulkUpdateStatus(req, res) {
  const { ids, status } = await json(req);

  const db = require('./database/db');

  const stmt = db.prepare('UPDATE orders SET status = ? WHERE id = ?');

  ids.forEach((id) => stmt.run(status, id));

  return send(res, 200, { success: true });
}
async function bulkDeleteOrders(req, res) {
  const { ids } = await json(req);

  const db = require('./database/db');

  const stmt = db.prepare('DELETE FROM orders WHERE id = ?');

  ids.forEach((id) => stmt.run(id));

  return send(res, 200, { success: true });
}
module.exports = router(
  post('/auth/request-code', requestCustomerCode),
  post('/auth/verify-code', verifyCustomerCode),
  post('/auth/logout', logoutCustomer),
  get('/account/session', getCustomerSession),
  get('/account/cards', listCustomerCards),
  get('/square-config', getSquareConfig),
  post('/account/cards/save', storeCard),
  post('/account/cards/remove', removeCustomerCard),
  post('/admin/orders/bulk-status', bulkUpdateStatus),
  post('/admin/orders/bulk-delete', bulkDeleteOrders),
  post('/payment', createPayment),
  post('/cash', createCashOrder),
  post('/order-status', getOrderStatus),
  get('/admin/orders', getAdminOrders),
  get('/admin', adminPage),
  post('/admin/orders/:id/status', updateOrderStatus),
  get('/catalog', getCatalog),
  get('/address-search', addressSearch),
  post('/validate-address', validateDeliveryAddress),
  get('/cart-summary', cartSummary),
  get('/*', serveStatic),
);
