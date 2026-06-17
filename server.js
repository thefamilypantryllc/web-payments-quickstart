// micro provides http helpers
const { createError, json, send } = require('micro');
// microrouter provides http server routing
const { router, get, post } = require('microrouter');
// serve-handler serves static assets
const staticHandler = require('serve-handler');
// async-retry will retry failed API requests
const retry = require('async-retry');

// logger gives us insight into what's happening
const logger = require('./server/logger');
// schema validates incoming requests
const { validateCreateCardPayload } = require('./server/schema');
// square provides the API client and error types
const { client: square } = require('./server/square');

const saveOrder = require('./database/saveOrder');

async function createPayment(req, res) {
  const payload = await json(req);

  if (!payload.items || payload.items.length === 0) {
    return send(res, 400, {
      success: false,
      error: 'Your cart is empty. Please add at least one item.',
    });
  }

  if (payload.lat && payload.lon) {
    const validationResponse = await fetch(
      'http://localhost:3000/validate-address',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lat: payload.lat,
          lon: payload.lon,
        }),
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

  console.log('CARD PAYMENT PAYLOAD:');
  console.dir(payload, { depth: null });

  logger.debug(JSON.stringify(payload));
  // We validate the payload for specific fields. You may disable this feature
  // if you would prefer to handle payload validation on your own.
  // temporarily disabled
  // if (!validatePaymentPayload(payload)) {
  //   throw createError(400, 'Bad Request');
  // }

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

      console.log('FULL ORDER RESPONSE');
      console.dir(orderResponse, { depth: null });

      const order = orderResponse.result?.order || orderResponse.order;

      const subtotal = Number(order.totalMoney.amount) / 100;

      const deliveryFee = subtotal < 40 ? 3.0 : 0;

      const salesTax = subtotal * 0.08225;

      const tipAmount = subtotal * ((payload.tipPercent || 0) / 100);

      const grandTotal = subtotal + deliveryFee + salesTax + tipAmount;

      console.log('CARD ORDER CREATED:');
      console.dir(order, { depth: null });

	const orderNumber = saveOrder({
	  squareOrderId: order.id,
	  customerName: `${payload.firstName} ${payload.lastName}`,
	  phone: payload.phone,
	  email: payload.email,
	  address: payload.address,
	  deliveryTime: payload.deliveryTime,
	  paymentMethod: 'Card',
	  status: 'Paid',
	  subtotal,
	  deliveryFee,
	  salesTax,
	  tip: tipAmount,
	  total: grandTotal,
	});

console.log('ORDER NUMBER:', orderNumber);

      console.log('ORDER NUMBER:', orderNumber);

      const payment = {
        idempotencyKey: payload.idempotencyKey,
        locationId: payload.locationId,
        sourceId: payload.sourceId,

        amountMoney: {
          amount: BigInt(Math.round(grandTotal * 100)),
          currency: 'USD',
        },
      };
      console.log('PAYMENT AMOUNT:', BigInt(Math.round(grandTotal * 100)));

      if (payload.customerId) {
        payment.customerId = payload.customerId;
      }

      // VerificationDetails is part of Secure Card Authentication.
      // This part of the payload is highly recommended (and required for some countries)
      // for 'unauthenticated' payment methods like Cards.
      if (payload.verificationToken) {
        payment.verificationToken = payload.verificationToken;
      }

      const { payment: paymentResponse } =
        await square.payments.create(payment);

      logger.info('Payment succeeded!', { paymentResponse });

      return send(res, 200, {
        success: true,

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
  const payload = await json(req);

  if (!validateCreateCardPayload(payload)) {
    throw createError(400, 'Bad Request');
  }

  await retry(async (bail, attempt) => {
    try {
      logger.debug('Storing card', { attempt });

      const cardReq = {
        idempotencyKey: payload.idempotencyKey,
        sourceId: payload.sourceId,
        card: {
          customerId: payload.customerId,
        },
      };

      if (payload.verificationToken) {
        cardReq.verificationToken = payload.verificationToken;
      }

      const { result, statusCode } = await square.cardsApi.createCard(cardReq);

      logger.info('Store Card succeeded!', { result, statusCode });

      // cast 64-bit values to string
      // to prevent JSON serialization error during send method
      result.card.expMonth = result.card.expMonth.toString();
      result.card.expYear = result.card.expYear.toString();
      result.card.version = result.card.version.toString();

      send(res, statusCode, {
        success: true,
        card: result.card,
      });
    } catch (ex) {
      if (ex.errors) {
        logger.error(ex.errors);
        bail(ex);
      } else {
        logger.error(
          `Error creating card-on-file on attempt ${attempt}: ${ex}`,
        );
        throw ex;
      }
    }
  });
}
async function createCashOrder(req, res) {
  const payload = await json(req);

  if (!payload.items || payload.items.length === 0) {
    return send(res, 400, {
      success: false,
      error: 'Your cart is empty. Please add at least one item.',
    });
  }

  if (payload.lat && payload.lon) {
    const validationResponse = await fetch(
      'http://localhost:3000/validate-address',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lat: payload.lat,
          lon: payload.lon,
        }),
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

	const orderNumber = saveOrder({
	  squareOrderId: order.id,
	  customerName: `${payload.firstName} ${payload.lastName}`,
	  phone: payload.phone,
	  email: payload.email,
	  address: payload.address,
	  deliveryTime: payload.deliveryTime,
	  paymentMethod: 'Cash',
	  status: 'Recieved',
  	  subtotal,
	  deliveryFee,
	  salesTax,
	  tip: tipAmount,
	  total: grandTotal,
	});

console.log('ORDER NUMBER:', orderNumber);
    const orderNumber = saveOrder({
      squareOrderId: order.id,
      customerName: `${payload.firstName} ${payload.lastName}`,
      phone: payload.phone,
      email: payload.email,
      address: payload.address,
      deliveryTime: payload.deliveryTime,
      paymentMethod: 'Cash',
      status: 'Recieved',
      subtotal,
      deliveryFee,
      salesTax,
      tip: tipAmount,
      total: grandTotal,
    });

    console.log('ORDER NUMBER:', orderNumber);

    return send(res, 200, {
      success: true,

      orderId: order.id,

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

    return send(res, 200, {
      success: true,
    });
  } catch (err) {
    console.error('CATALOG ERROR:', err);

    return send(res, 500, {
      success: false,
      error: err.message,
    });
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

    return send(res, 500, {
      error: err.message,
    });
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

    return send(res, 200, {
      allowed: miles <= 15,
      miles,
    });
  } catch (err) {
    console.error(err);

    return send(res, 500, {
      allowed: false,
      error: err.message,
    });
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

  const order = response.order;

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

  await staticHandler(req, res, {
    public: 'public',
  });
}
module.exports = router(
  post('/payment', createPayment),
  post('/card', storeCard),
  post('/cash', createCashOrder),

  get('/catalog', getCatalog),
  get('/address-search', addressSearch),
  post('/validate-address', validateDeliveryAddress),
  get('/cart-summary', cartSummary),
  get('/*', serveStatic),
);
