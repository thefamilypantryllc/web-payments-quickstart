const { SquareClient, SquareEnvironment } = require('square');

const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN || process.env.SQUARE_TOKEN,
  environment: SquareEnvironment.Sandbox,
});

module.exports = { client };
