const { SquareClient, SquareEnvironment } = require('square');

const { isProduction, SQUARE_ACCESS_TOKEN } = require('./config');

const client = new SquareClient({
  token: SQUARE_ACCESS_TOKEN,

  environment: isProduction
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox,
});

module.exports = { client };
