const { Pool } = require("pg");
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 5,
  connectionTimeoutMillis: 5000,
  statement_timeout: 15000,
});
const qi = (s) => '"' + String(s).replaceAll('"', '""') + '"';
module.exports = { pool, qi };
