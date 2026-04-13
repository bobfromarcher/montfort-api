CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  company VARCHAR(255),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  plan VARCHAR(32) NOT NULL DEFAULT 'starter',
  stripe_customer_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  key_hash VARCHAR(128) UNIQUE NOT NULL,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan VARCHAR(32) NOT NULL DEFAULT 'starter',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS agents (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  endpoint TEXT NOT NULL,
  model VARCHAR(128) NOT NULL DEFAULT 'default',
  system_prompt TEXT DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'idle',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dispatches (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id VARCHAR(64) REFERENCES agents(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'api',
  status VARCHAR(32) NOT NULL DEFAULT 'accepted',
  latency_ms INTEGER,
  billable BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monthly_usage (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month VARCHAR(7) NOT NULL,
  dispatches_used INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, month)
);

CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_agents_user ON agents(user_id);
CREATE INDEX idx_dispatches_user ON dispatches(user_id);
CREATE INDEX idx_dispatches_created ON dispatches(created_at);
CREATE INDEX idx_monthly_usage_user_month ON monthly_usage(user_id, month);
