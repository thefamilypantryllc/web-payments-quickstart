const db = require('./db');

function addColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();

  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE,
    square_order_id TEXT,
    customer_name TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    delivery_time TEXT,
    payment_method TEXT,
    status TEXT DEFAULT 'Received',
    subtotal REAL,
    delivery_fee REAL,
    sales_tax REAL,
    tip REAL,
    total REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    square_customer_id TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS login_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL COLLATE NOCASE,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_login_codes_email
    ON login_codes(email, created_at);

  CREATE TABLE IF NOT EXISTS customer_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_customer_sessions_token
    ON customer_sessions(token_hash);
`);

addColumn('orders', 'customer_id', 'INTEGER');
addColumn('customers', 'first_name', 'TEXT');
addColumn('customers', 'last_name', 'TEXT');
addColumn('customers', 'phone', 'TEXT');
addColumn('customers', 'default_address', 'TEXT');
addColumn('customers', 'marketing_consent', 'INTEGER NOT NULL DEFAULT 0');
addColumn('customers', 'marketing_consent_at', 'DATETIME');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
  CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);
`);

console.log('Orders table ready');
