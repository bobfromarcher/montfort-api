const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.argv[2] || process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Usage: node migrate.js <DATABASE_URL>');
  process.exit(1);
}

async function migrate() {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', '001_initial.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('Migration complete');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
