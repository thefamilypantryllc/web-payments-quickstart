const { SquareClient, SquareEnvironment } = require('square');

const { isProduction, SQUARE_ACCESS_TOKEN } = require('./config');

const client = new SquareClient({
  token:
    process.env.SQUARE_ACCESS_TOKEN ||
    process.env.SQUARE_TOKEN,
  environment: SquareEnvironment.Sandbox,
});

module.exports = { client };
