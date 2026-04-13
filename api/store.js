const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

async function query(text, params) {
  return pool.query(text, params);
}

async function getUserByEmail(email) {
  const r = await query('SELECT * FROM users WHERE email = $1', [email]);
  return r.rows[0] || null;
}

async function getUserById(id) {
  const r = await query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function createUser({ id, email, company, passwordHash, passwordSalt, plan }) {
  await query(
    'INSERT INTO users (id, email, company, password_hash, password_salt, plan) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, email, company, passwordHash, passwordSalt, plan || 'starter']
  );
  return getUserById(id);
}

async function updateUserPlan(userId, plan, stripeCustomerId) {
  const parts = ['plan = $2'];
  const vals = [userId, plan];
  if (stripeCustomerId) { parts.push('stripe_customer_id = $' + (vals.length + 1)); vals.push(stripeCustomerId); }
  vals.push(userId);
  await query(`UPDATE users SET ${parts.join(', ')} WHERE id = $1`, [userId, plan, stripeCustomerId].filter(Boolean));
}

async function createApiKey(keyHash, userId, plan) {
  await query(
    'INSERT INTO api_keys (key_hash, user_id, plan) VALUES ($1, $2, $3)',
    [keyHash, userId, plan]
  );
}

async function getApiKeyByKey(keyHash) {
  const r = await query(
    `SELECT ak.*, u.email, u.plan as user_plan FROM api_keys ak JOIN users u ON ak.user_id = u.id WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
    [keyHash]
  );
  return r.rows[0] || null;
}

async function revokeApiKeysForUser(userId) {
  await query('UPDATE api_keys SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

async function createAgent({ id, userId, name, endpoint, model, systemPrompt }) {
  await query(
    'INSERT INTO agents (id, user_id, name, endpoint, model, system_prompt) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, name, endpoint, model || 'default', systemPrompt || '']
  );
  const r = await query('SELECT * FROM agents WHERE id = $1', [id]);
  return r.rows[0];
}

async function getAgentsByUser(userId) {
  const r = await query('SELECT * FROM agents WHERE user_id = $1', [userId]);
  return r.rows;
}

async function countAgentsByUser(userId) {
  const r = await query('SELECT COUNT(*) as cnt FROM agents WHERE user_id = $1', [userId]);
  return parseInt(r.rows[0].cnt, 10);
}

async function createDispatch({ id, userId, agentId, prompt, source, status }) {
  await query(
    'INSERT INTO dispatches (id, user_id, agent_id, prompt, source, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, agentId, prompt, source || 'api', status || 'accepted']
  );
}

async function getMonthlyUsage(userId, month) {
  const r = await query('SELECT * FROM monthly_usage WHERE user_id = $1 AND month = $2', [userId, month]);
  return r.rows[0] || null;
}

async function incrementMonthlyUsage(userId, month) {
  await query(
    `INSERT INTO monthly_usage (user_id, month, dispatches_used) VALUES ($1, $2, 1) ON CONFLICT (user_id, month) DO UPDATE SET dispatches_used = monthly_usage.dispatches_used + 1`,
    [userId, month]
  );
}

module.exports = {
  query, getUserByEmail, getUserById, createUser, updateUserPlan,
  createApiKey, getApiKeyByKey, revokeApiKeysForUser,
  createAgent, getAgentsByUser, countAgentsByUser,
  createDispatch, getMonthlyUsage, incrementMonthlyUsage
};
