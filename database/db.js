const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const databasePath =
  process.env.SQLITE_DB_PATH ||
  (process.env.WEBSITE_INSTANCE_ID
    ? path.join(process.env.HOME || '/home', 'data', 'orders.db')
    : path.join(__dirname, 'orders.db'));

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);

module.exports = db;
