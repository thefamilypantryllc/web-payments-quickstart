// ava is a test runner for Node.js that isolates tests
const test = require('ava');
// micro is a minimal http framework (what's run by `npm start`)
const micro = require('micro');
// test-listen creates URLs with ephimeral ports ideal for isolated tests
const listen = require('test-listen');
// node-fetch brings window.fetch to Node.js
const fetch = require('node-fetch');
const main = require('.');

// serveStatic
const staticTests = [
  ['/', /Credit\/Debit Card/],
  ['/index.html', /sandbox\.web\.squarecdn/],
  ['/favicon.ico', /.+/],
];

staticTests.forEach(([path, re]) => {
  test(`serves ${path}`, async (t) => {
    const service = micro(main);
    const url = await listen(service);
    try {
      const res = await fetch(url + path);
      t.true(res.ok);
      const body = await res.text();
      t.regex(body, re);
    } finally {
      service.close();
    }
  });
});

// createPayment
test('createPayment errors with invalid payload', async (t) => {
  const service = micro(main);
  const url = await listen(service);
  try {
    const res = await fetch(`${url}/payment`, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong: true }),
    });
    t.false(res.ok);
    t.is(res.status, 400);
  } finally {
    service.close();
  }
});

// storeCard
test('storeCard errors with invalid payload', async (t) => {
  const service = micro(main);
  const url = await listen(service);
  try {
    const res = await fetch(`${url}/card`, {
      method: 'post',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrong: true }),
    });
    t.false(res.ok);
    t.is(res.status, 400);
  } finally {
    service.close();
  }
});
