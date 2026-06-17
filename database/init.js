const db = require('./db');

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

console.log('Orders table ready');