const crypto = require('crypto');
const db = require('./database/db');
const { client: square } = require('./server/square');

const CODE_LIFETIME_MINUTES = 10;
const SESSION_LIFETIME_DAYS = 30;

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isCustomerAccountsEnabled() {
  return (
    String(process.env.CUSTOMER_ACCOUNTS_ENABLED).toLowerCase() === 'true' &&
    Boolean(process.env.LOGIN_CODE_POWER_AUTOMATE_URL)
  );
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        return [
          decodeURIComponent(part.slice(0, separator)),
          decodeURIComponent(part.slice(separator + 1)),
        ];
      }),
  );
}

function getSession(req) {
  const token = parseCookies(req).fp_session;
  if (!token) return null;

  return (
    db
      .prepare(
        `
          SELECT
            customer_sessions.id AS session_id,
            customers.id,
            customers.email,
            customers.square_customer_id,
            customers.first_name,
            customers.last_name,
            customers.phone,
            customers.default_address,
            customers.marketing_consent,
            customers.marketing_consent_at
          FROM customer_sessions
          JOIN customers ON customers.id = customer_sessions.customer_id
          WHERE customer_sessions.token_hash = ?
            AND customer_sessions.expires_at > CURRENT_TIMESTAMP
        `,
      )
      .get(hash(token)) || null
  );
}

function requireSession(req) {
  const session = getSession(req);
  if (!session) {
    const error = new Error('Please sign in to continue.');
    error.statusCode = 401;
    throw error;
  }
  return session;
}

function setSessionCookie(req, res, token) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '');
  const secure = forwardedProto === 'https' ? '; Secure' : '';
  const maxAge = SESSION_LIFETIME_DAYS * 24 * 60 * 60;

  res.setHeader(
    'Set-Cookie',
    `fp_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    'fp_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0',
  );
}

async function sendLoginCode(email, code) {
  if (!isCustomerAccountsEnabled()) {
    const error = new Error('Customer sign-in is not available yet.');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(process.env.LOGIN_CODE_POWER_AUTOMATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventType: 'customerLoginCode',
      email,
      code,
      expiresMinutes: CODE_LIFETIME_MINUTES,
    }),
  });

  if (!response.ok) {
    throw new Error('Power Automate could not send the sign-in code.');
  }
}

async function ensureSquareCustomer(customer) {
  if (customer.square_customer_id) return customer.square_customer_id;

  const searchResponse = await square.customers.search({
    query: {
      filter: {
        emailAddress: {
          exact: customer.email,
        },
      },
    },
  });
  const existing =
    searchResponse.customers?.[0] || searchResponse.result?.customers?.[0];
  let squareCustomerId = existing?.id;

  if (!squareCustomerId) {
    const createResponse = await square.customers.create({
      idempotencyKey: crypto.randomUUID(),
      emailAddress: customer.email,
      referenceId: `family-pantry-${customer.id}`,
    });
    squareCustomerId =
      createResponse.customer?.id || createResponse.result?.customer?.id;
  }

  if (!squareCustomerId) {
    throw new Error('Unable to create the Square customer profile.');
  }

  db.prepare(
    'UPDATE customers SET square_customer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  ).run(squareCustomerId, customer.id);

  return squareCustomerId;
}

async function requestLoginCode(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    const error = new Error('Please enter a valid email address.');
    error.statusCode = 400;
    throw error;
  }

  const recent = db
    .prepare(
      `
        SELECT id
        FROM login_codes
        WHERE email = ?
          AND created_at > datetime('now', '-60 seconds')
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .get(normalizedEmail);

  if (recent) {
    const error = new Error(
      'Please wait a minute before requesting another code.',
    );
    error.statusCode = 429;
    throw error;
  }

  const code = String(crypto.randomInt(100000, 1000000));
  await sendLoginCode(normalizedEmail, code);

  db.prepare(
    `
      INSERT INTO login_codes (email, code_hash, expires_at)
      VALUES (?, ?, datetime('now', '+${CODE_LIFETIME_MINUTES} minutes'))
    `,
  ).run(normalizedEmail, hash(`${normalizedEmail}:${code}`));
}

async function verifyLoginCode(email, code) {
  const normalizedEmail = normalizeEmail(email);
  const record = db
    .prepare(
      `
        SELECT *
        FROM login_codes
        WHERE email = ?
          AND consumed_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP
        ORDER BY id DESC
        LIMIT 1
      `,
    )
    .get(normalizedEmail);

  if (!record || record.attempts >= 5) {
    const error = new Error('That code is invalid or has expired.');
    error.statusCode = 400;
    throw error;
  }

  const expected = Buffer.from(record.code_hash, 'hex');
  const actual = Buffer.from(
    hash(`${normalizedEmail}:${String(code).trim()}`),
    'hex',
  );

  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    db.prepare(
      'UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?',
    ).run(record.id);
    const error = new Error('That code is invalid or has expired.');
    error.statusCode = 400;
    throw error;
  }

  db.prepare(
    'UPDATE login_codes SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?',
  ).run(record.id);

  db.prepare('INSERT OR IGNORE INTO customers (email) VALUES (?)').run(
    normalizedEmail,
  );
  const customer = db
    .prepare('SELECT * FROM customers WHERE email = ?')
    .get(normalizedEmail);

  db.prepare(
    `
      UPDATE orders
      SET customer_id = ?
      WHERE customer_id IS NULL AND LOWER(email) = ?
    `,
  ).run(customer.id, normalizedEmail);

  const squareCustomerId = await ensureSquareCustomer(customer);
  const token = crypto.randomBytes(32).toString('base64url');

  db.prepare(
    `
      INSERT INTO customer_sessions (customer_id, token_hash, expires_at)
      VALUES (?, ?, datetime('now', '+${SESSION_LIFETIME_DAYS} days'))
    `,
  ).run(customer.id, hash(token));

  return {
    token,
    customer: {
      id: customer.id,
      email: normalizedEmail,
      squareCustomerId,
    },
  };
}

module.exports = {
  clearSessionCookie,
  ensureSquareCustomer,
  getSession,
  isCustomerAccountsEnabled,
  normalizeEmail,
  requestLoginCode,
  requireSession,
  setSessionCookie,
  verifyLoginCode,
};
