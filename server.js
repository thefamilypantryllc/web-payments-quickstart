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

async function createPayment(req, res) {
  const payload = await json(req);

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

      const order = orderResponse.order;

      console.log('CARD ORDER CREATED:');
      console.dir(order, { depth: null });

      const payment = {
        idempotencyKey: payload.idempotencyKey,
        locationId: payload.locationId,
        sourceId: payload.sourceId,

        orderId: order.id,

        amountMoney: {
          amount: order.totalMoney.amount,
          currency: 'USD',
        },
      };

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

      send(res, 200, {
        success: true,

        payment: {
          id: paymentResponse.id,
          status: paymentResponse.status,
          receiptUrl: paymentResponse.receiptUrl,
          orderId: paymentResponse.orderId,
        },

        orderId: order.id,
        status: 'PAID',
        total: Number(order.totalMoney.amount) / 100,

        items: order.lineItems.map((item) => ({
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

  try {
    logger.info('Creating cash order', payload);

    console.log('STEP 1');

    console.log('ITEMS RECEIVED:');
    console.dir(payload.items, { depth: null });

    const response = await square.orders.create({
      idempotencyKey: payload.idempotencyKey,

      order: {
        locationId: payload.locationId,

        lineItems: payload.items.map((item) => ({
          catalogObjectId: item.catalogObjectId,
          quantity: item.quantity,
        })),
      },
    });

    console.log('STEP 2');
    console.log('RESPONSE.ORDER');
    console.dir(response.order, { depth: null });

    console.log('RESPONSE.RESULT');
    console.dir(response.result, { depth: null });
    console.dir(response, { depth: null });

    const order = response.order;

    console.log('ORDER:', order);

    return send(res, 200, {
      success: true,
      orderId: order.id,
      status: order.state,
      total: Number(order.totalMoney.amount) / 100,
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
// serve static files like index.html and favicon.ico from public/ directory
async function serveStatic(req, res) {
  logger.debug('Handling request', req.path);
  await staticHandler(req, res, {
    public: 'public',
  });
}

// export routes to be served by micro
module.exports = router(
  post('/payment', createPayment),
  post('/card', storeCard),
  post('/cash', createCashOrder),

  get('/catalog', getCatalog),

  get('/*', serveStatic),
);
