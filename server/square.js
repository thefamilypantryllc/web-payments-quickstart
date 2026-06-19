const { SquareClient, SquareEnvironment } = require('square');

const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN || process.env.SQUARE_TOKEN,
  environment:
    String(process.env.SQUARE_ENVIRONMENT).toLowerCase() === 'sandbox'
      ? SquareEnvironment.Sandbox
      : SquareEnvironment.Production,
});

module.exports = { client };
