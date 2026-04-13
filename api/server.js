require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

const app = express();
app.use(cors());
app.use(express.json());

const PLANS = {
  starter: { name: 'Starter', price: 0, dispatches: 1000, agents: 3 },
  professional: { name: 'Professional', price: 4900, dispatches: 50000, agents: -1 },
  enterprise: { name: 'Enterprise', price: 0, dispatches: -1, agents: -1 }
};

const STRIPE_PRICES = {
  professional: process.env.STRIPE_PRO_PRICE_ID || 'price_1TLbZt6A0FWaBxvbQELMIfvu'
};

const USE_PG = !!process.env.DATABASE_URL;
let store = null;
let db = { users: {}, agents: {}, dispatches: {}, apikeys: {} };
let pgError = null;

if (USE_PG) {
  try {
    store = require('./store');
    console.log('PostgreSQL storage enabled, DATABASE_URL present');
  } catch (err) {
    pgError = err.message;
    console.error('Failed to load PG store, falling back to in-memory:', err.message);
  }
} else {
  console.log('No DATABASE_URL found, using in-memory storage');
}

function generateApiKey() {
  return 'mf_' + crypto.randomBytes(24).toString('hex');
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function authMiddleware(req, res, next) {
  const key = req.headers['authorization']?.replace('Bearer ', '');
  if (!key) return res.status(401).json({ error: 'Invalid API key' });

  if (store) {
    const hashed = hashApiKey(key);
    const apiKeyRow = await store.getApiKeyByKey(hashed);
    if (!apiKeyRow) return res.status(401).json({ error: 'Invalid API key' });
    req.user = { id: apiKeyRow.user_id, email: apiKeyRow.email, plan: apiKeyRow.user_plan };
  } else {
    if (!db.apikeys[key]) return res.status(401).json({ error: 'Invalid API key' });
    req.user = db.apikeys[key];
  }
  next();
}

async function dispatchLimitMiddleware(req, res, next) {
  const user = req.user;
  const plan = PLANS[user.plan];
  if (plan.dispatches > 0) {
    const month = new Date().toISOString().slice(0, 7);
    if (store) {
      const usage = await store.getMonthlyUsage(user.id, month);
      if (usage && usage.dispatches_used >= plan.dispatches) {
        return res.status(429).json({ error: 'Dispatch limit exceeded', usage: usage.dispatches_used, limit: plan.dispatches });
      }
    } else {
      const usage = db.dispatches[user.id]?.[month] || 0;
      if (usage >= plan.dispatches) {
        return res.status(429).json({ error: 'Dispatch limit exceeded', usage, limit: plan.dispatches });
      }
    }
  }
  next();
}

app.post('/api/v1/register', async (req, res) => {
  const { email, password, company } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const id = 'usr_' + crypto.randomBytes(12).toString('hex');
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  const saltHex = salt.toString('hex');

  if (store) {
    const existing = await store.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    await store.createUser({ id, email, company: company || null, passwordHash: hash, passwordSalt: saltHex, plan: 'starter' });
  } else {
    const existing = Object.values(db.users).find(u => u.email === email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    db.users[id] = { id, email, company: company || null, passwordHash: hash, passwordSalt: saltHex, plan: 'starter', stripeCustomerId: null, createdAt: new Date().toISOString() };
  }

  const apiKey = generateApiKey();

  if (store) {
    await store.createApiKey(hashApiKey(apiKey), id, 'starter');
  } else {
    db.apikeys[apiKey] = { id, email, plan: 'starter' };
  }

  res.status(201).json({
    user: { id, email, plan: 'starter', company: company || null },
    apiKey,
    message: 'Account created. You have 1,000 dispatches/month on the Starter plan.'
  });
});

app.post('/api/v1/login', async (req, res) => {
  const { email, password } = req.body;

  let user;
  if (store) {
    user = await store.getUserByEmail(email);
  } else {
    user = Object.values(db.users).find(u => u.email === email);
  }

  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const hash = crypto.pbkdf2Sync(password, Buffer.from(user.password_salt || user.passwordSalt, 'hex'), 100000, 64, 'sha512').toString('hex');
  if (hash !== (user.password_hash || user.passwordHash)) return res.status(401).json({ error: 'Invalid credentials' });

  const apiKey = generateApiKey();
  const plan = user.plan || 'starter';

  if (store) {
    await store.createApiKey(hashApiKey(apiKey), user.id, plan);
  } else {
    db.apikeys[apiKey] = { id: user.id, email: user.email, plan };
  }

  res.json({ user: { id: user.id, email: user.email, plan }, apiKey });
});

app.post('/api/v1/apikeys', authMiddleware, async (req, res) => {
  const apiKey = generateApiKey();
  const user = req.user;

  if (store) {
    await store.createApiKey(hashApiKey(apiKey), user.id, user.plan);
  } else {
    db.apikeys[apiKey] = { id: user.id, email: user.email, plan: user.plan };
  }

  res.status(201).json({ apiKey, createdAt: new Date().toISOString() });
});

app.get('/api/v1/usage', authMiddleware, async (req, res) => {
  const user = req.user;
  const plan = PLANS[user.plan];
  const month = new Date().toISOString().slice(0, 7);

  let dispatchesUsed, agentsUsed;
  if (store) {
    const usageRow = await store.getMonthlyUsage(user.id, month);
    dispatchesUsed = usageRow ? usageRow.dispatches_used : 0;
    agentsUsed = await store.countAgentsByUser(user.id);
  } else {
    dispatchesUsed = db.dispatches[user.id]?.[month] || 0;
    agentsUsed = Object.values(db.agents).filter(a => a.userId === user.id).length;
  }

  res.json({
    plan: user.plan,
    planName: plan.name,
    dispatchesUsed,
    dispatchesLimit: plan.dispatches === -1 ? 'unlimited' : plan.dispatches,
    agentsUsed,
    agentsLimit: plan.agents === -1 ? 'unlimited' : plan.agents
  });
});

app.post('/api/v1/dispatch', authMiddleware, dispatchLimitMiddleware, async (req, res) => {
  const user = req.user;
  const { agentId, prompt, source } = req.body;

  if (!agentId || !prompt) return res.status(400).json({ error: 'agentId and prompt required' });

  if (store) {
    const agents = await store.getAgentsByUser(user.id);
    const agent = agents.find(a => a.id === agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
  } else {
    const agent = db.agents[agentId];
    if (!agent || agent.userId !== user.id) return res.status(404).json({ error: 'Agent not found' });
  }

  const dispatchId = 'dsp_' + crypto.randomBytes(12).toString('hex');
  const month = new Date().toISOString().slice(0, 7);

  if (store) {
    await store.createDispatch({ id: dispatchId, userId: user.id, agentId, prompt, source: source || 'api', status: 'accepted' });
    await store.incrementMonthlyUsage(user.id, month);
  } else {
    if (!db.dispatches[user.id]) db.dispatches[user.id] = {};
    db.dispatches[user.id][month] = (db.dispatches[user.id][month] || 0) + 1;
  }

  res.json({
    dispatchId, agentId, status: 'accepted',
    source: source || 'api', timestamp: new Date().toISOString(), billable: true
  });
});

app.post('/api/v1/agents', authMiddleware, async (req, res) => {
  const user = req.user;
  const plan = PLANS[user.plan];

  let agentCount;
  if (store) {
    agentCount = await store.countAgentsByUser(user.id);
  } else {
    agentCount = Object.values(db.agents).filter(a => a.userId === user.id).length;
  }

  if (plan.agents > 0 && agentCount >= plan.agents) {
    return res.status(403).json({ error: `Agent limit reached (${plan.agents}). Upgrade your plan.` });
  }

  const { name, endpoint, model, systemPrompt } = req.body;
  if (!name || !endpoint) return res.status(400).json({ error: 'name and endpoint required' });

  const agentId = 'agt_' + crypto.randomBytes(12).toString('hex');

  if (store) {
    const agent = await store.createAgent({ id: agentId, userId: user.id, name, endpoint, model: model || 'default', systemPrompt: systemPrompt || '' });
    res.status(201).json({ ...agent, status: 'idle' });
  } else {
    const agent = { id: agentId, userId: user.id, name, endpoint, model: model || 'default', systemPrompt: systemPrompt || '', status: 'idle', createdAt: new Date().toISOString() };
    db.agents[agentId] = agent;
    res.status(201).json(agent);
  }
});

app.get('/api/v1/agents', authMiddleware, async (req, res) => {
  if (store) {
    const agents = await store.getAgentsByUser(req.user.id);
    res.json(agents);
  } else {
    res.json(Object.values(db.agents).filter(a => a.userId === req.user.id));
  }
});

app.post('/api/v1/billing/checkout', authMiddleware, async (req, res) => {
  const user = req.user;
  const { plan } = req.body;

  if (!STRIPE_PRICES[plan]) return res.status(400).json({ error: 'Invalid plan for checkout' });

  let dbUser;
  if (store) {
    dbUser = await store.getUserById(user.id);
  } else {
    dbUser = db.users[user.id];
  }

  if (!dbUser) return res.status(404).json({ error: 'User not found' });

  if (!process.env.STRIPE_SECRET_KEY) {
    if (store) {
      await store.updateUserPlan(user.id, plan, dbUser.stripe_customer_id);
    } else {
      dbUser.plan = plan;
      db.apikeys = Object.fromEntries(
        Object.entries(db.apikeys).map(([k, v]) => v.id === user.id ? [k, { ...v, plan }] : [k, v])
      );
    }
    return res.json({ url: null, message: `Upgraded to ${PLANS[plan].name} (no Stripe configured - direct upgrade)` });
  }

  try {
    if (!dbUser.stripe_customer_id && !dbUser.stripeCustomerId) {
      const customer = await stripe.customers.create({ email: user.email });
      if (store) {
        await store.updateUserPlan(user.id, plan, customer.id);
      } else {
        dbUser.stripeCustomerId = customer.id;
      }
    }

    const stripeCustomerId = dbUser.stripe_customer_id || dbUser.stripeCustomerId;
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      line_items: [{ price: STRIPE_PRICES[plan], quantity: 1 }],
      mode: 'subscription',
      success_url: process.env.SITE_URL + '/billing?success=true',
      cancel_url: process.env.SITE_URL + '/billing?canceled=true'
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'operational',
    version: '1.0.0',
    storage: store ? 'postgresql' : 'memory',
    databaseUrlSet: !!process.env.DATABASE_URL,
    pgModuleError: pgError,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log(`Montfort API running on port ${PORT} [${store ? 'PostgreSQL' : 'In-Memory'}]`);
});

module.exports = app;
