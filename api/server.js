require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

const app = express();

const ALLOWED_ORIGINS = [
  'https://www.gradeafoods.com',
  'https://gradeafoods.com',
  'https://api.gradeafoods.com',
  'http://localhost:3000',
  'http://localhost:3100'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(null, false);
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

const authRateLimiter = new Map();
const AUTH_RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = 10;
const ipRateLimiter = new Map();
const IP_RATE_LIMIT_WINDOW = 60 * 1000;
const IP_RATE_LIMIT_MAX = 60;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authRateLimiter) {
    if (now - v.windowStart > AUTH_RATE_LIMIT_WINDOW) authRateLimiter.delete(k);
  }
  for (const [k, v] of ipRateLimiter) {
    if (now - v.windowStart > IP_RATE_LIMIT_WINDOW) ipRateLimiter.delete(k);
  }
}, 5 * 60 * 1000);

function checkAuthRateLimit(email) {
  const key = email.toLowerCase();
  const now = Date.now();
  const record = authRateLimiter.get(key) || { count: 0, windowStart: now };
  if (now - record.windowStart > AUTH_RATE_LIMIT_WINDOW) {
    record.count = 1;
    record.windowStart = now;
  } else {
    record.count++;
  }
  authRateLimiter.set(key, record);
  if (record.count > AUTH_RATE_LIMIT_MAX) return false;
  return true;
}

function checkIpRateLimit(ip) {
  const now = Date.now();
  const record = ipRateLimiter.get(ip) || { count: 0, windowStart: now };
  if (now - record.windowStart > IP_RATE_LIMIT_WINDOW) {
    record.count = 1;
    record.windowStart = now;
  } else {
    record.count++;
  }
  ipRateLimiter.set(ip, record);
  return record.count <= IP_RATE_LIMIT_MAX;
}

app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown';
  if (!checkIpRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  next();
});

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

if (USE_PG) {
  try {
    store = require('./store');
    console.log('PostgreSQL storage enabled');
  } catch (err) {
    console.error('Failed to load PG store, falling back to in-memory:', err.message);
  }
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
  const sanitizedEmail = String(email).toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitizedEmail)) return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!checkAuthRateLimit(sanitizedEmail + ':register')) return res.status(429).json({ error: 'Too many registration attempts. Try again later.' });

  const id = 'usr_' + crypto.randomBytes(12).toString('hex');
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  const saltHex = salt.toString('hex');

  if (store) {
    const existing = await store.getUserByEmail(sanitizedEmail);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    await store.createUser({ id, email: sanitizedEmail, company: company ? String(company).slice(0, 255) : null, passwordHash: hash, passwordSalt: saltHex, plan: 'starter' });
  } else {
    const existing = Object.values(db.users).find(u => u.email === sanitizedEmail);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    db.users[id] = { id, email: sanitizedEmail, company: company ? String(company).slice(0, 255) : null, passwordHash: hash, passwordSalt: saltHex, plan: 'starter', stripeCustomerId: null, createdAt: new Date().toISOString() };
  }

  const apiKey = generateApiKey();

  if (store) {
    await store.createApiKey(hashApiKey(apiKey), id, 'starter');
  } else {
    db.apikeys[apiKey] = { id, email, plan: 'starter' };
  }

  res.status(201).json({
    user: { id, email: sanitizedEmail, plan: 'starter', company: company ? String(company).slice(0, 255) : null },
    apiKey,
    message: 'Account created. You have 1,000 dispatches/month on the Starter plan.'
  });
});

app.post('/api/v1/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!checkAuthRateLimit(email + ':login')) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });

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
  const sanitizedAgentId = String(agentId).slice(0, 128);
  const sanitizedPrompt = String(prompt).slice(0, 10000);
  const sanitizedSource = String(source || 'api').slice(0, 32);

  if (store) {
    const agents = await store.getAgentsByUser(user.id);
    const agent = agents.find(a => a.id === sanitizedAgentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
  } else {
    const agent = db.agents[sanitizedAgentId];
    if (!agent || agent.userId !== user.id) return res.status(404).json({ error: 'Agent not found' });
  }

  const dispatchId = 'dsp_' + crypto.randomBytes(12).toString('hex');
  const month = new Date().toISOString().slice(0, 7);

  if (store) {
    await store.createDispatch({ id: dispatchId, userId: user.id, agentId: sanitizedAgentId, prompt: sanitizedPrompt, source: sanitizedSource, status: 'accepted' });
    await store.incrementMonthlyUsage(user.id, month);
  } else {
    if (!db.dispatches[user.id]) db.dispatches[user.id] = {};
    db.dispatches[user.id][month] = (db.dispatches[user.id][month] || 0) + 1;
  }

  res.json({
    dispatchId, agentId: sanitizedAgentId, status: 'accepted',
    source: sanitizedSource, timestamp: new Date().toISOString(), billable: true
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
  const sanitizedName = String(name).slice(0, 255);
  const sanitizedEndpoint = String(endpoint).slice(0, 2048);
  const sanitizedModel = String(model || 'default').slice(0, 128);
  const sanitizedPrompt = String(systemPrompt || '').slice(0, 50000);

  const agentId = 'agt_' + crypto.randomBytes(12).toString('hex');

  if (store) {
    const agent = await store.createAgent({ id: agentId, userId: user.id, name: sanitizedName, endpoint: sanitizedEndpoint, model: sanitizedModel, systemPrompt: sanitizedPrompt });
    res.status(201).json({ ...agent, status: 'idle' });
  } else {
    const agent = { id: agentId, userId: user.id, name: sanitizedName, endpoint: sanitizedEndpoint, model: sanitizedModel, systemPrompt: sanitizedPrompt, status: 'idle', createdAt: new Date().toISOString() };
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
      metadata: { userId: user.id, plan, priceId: STRIPE_PRICES[plan] },
      success_url: process.env.SITE_URL + '/billing?success=true',
      cancel_url: process.env.SITE_URL + '/billing?canceled=true'
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v1/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send('Missing signature or webhook secret');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer;
        const priceId = session.line_items?.data?.[0]?.price?.id || session.metadata?.priceId;
        let plan = 'starter';
        for (const [p, pid] of Object.entries(STRIPE_PRICES)) {
          if (pid === priceId) { plan = p; break; }
        }

        if (store) {
          const user = await store.getUserByStripeCustomer(customerId);
          if (user) {
            await store.updateUserPlan(user.id, plan, customerId);
            await store.revokeApiKeysForUser(user.id);
          }
        } else {
          const user = Object.values(db.users).find(u => u.stripeCustomerId === customerId || u.stripe_customer_id === customerId);
          if (user) {
            user.plan = plan;
            if (!user.stripeCustomerId) user.stripeCustomerId = customerId;
            db.apikeys = Object.fromEntries(
              Object.entries(db.apikeys).map(([k, v]) => v.id === user.id ? [k, { ...v, plan }] : [k, v])
            );
          }
        }
        console.log(`Checkout completed: customer=${customerId}, plan=${plan}`);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        const priceId = sub.items?.data?.[0]?.price?.id;
        let plan = 'starter';
        for (const [p, pid] of Object.entries(STRIPE_PRICES)) {
          if (pid === priceId) { plan = p; break; }

        }
        if (store) {
          const user = await store.getUserByStripeCustomer(customerId);
          if (user) await store.updateUserPlan(user.id, plan, customerId);
        } else {
          const user = Object.values(db.users).find(u => u.stripeCustomerId === customerId);
          if (user) {
            user.plan = plan;
            db.apikeys = Object.fromEntries(
              Object.entries(db.apikeys).map(([k, v]) => v.id === user.id ? [k, { ...v, plan }] : [k, v])
            );
          }
        }
        console.log(`Subscription updated: customer=${customerId}, plan=${plan}`);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;
        if (store) {
          const user = await store.getUserByStripeCustomer(customerId);
          if (user) await store.updateUserPlan(user.id, 'starter', customerId);
        } else {
          const user = Object.values(db.users).find(u => u.stripeCustomerId === customerId);
          if (user) {
            user.plan = 'starter';
            db.apikeys = Object.fromEntries(
              Object.entries(db.apikeys).map(([k, v]) => v.id === user.id ? [k, { ...v, plan: 'starter' }] : [k, v])
            );
          }
        }
        console.log(`Subscription canceled: customer=${customerId}, downgraded to starter`);
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).send('Handler error');
  }

  res.json({ received: true });
});

app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'operational', version: '1.0.0', storage: store ? 'postgresql' : 'memory', timestamp: new Date().toISOString() });
});

app.post('/api/v1/llm', authMiddleware, dispatchLimitMiddleware, async (req, res) => {
  const { messages, model } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const fetchMod = (await import('node-fetch')).default;
      const resp = await fetchMod('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: model || process.env.LLM_MODEL || 'llama-3.3-70b-versatile',
          messages,
          stream: false,
          max_tokens: 2048
        }),
        timeout: 60000
      });
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || '';
      if (!content) return res.status(502).json({ error: 'LLM returned empty', details: data.error?.message });

      const month = new Date().toISOString().slice(0, 7);
      if (store) {
        const dispatchId = 'dsp_' + crypto.randomBytes(12).toString('hex');
        await store.createDispatch({ id: dispatchId, userId: req.user.id, agentId: 'llm-proxy', prompt: messages[messages.length - 1]?.content?.slice(0, 1000) || '', source: 'api', status: 'completed' });
        await store.incrementMonthlyUsage(req.user.id, month);
      }

      return res.json({ content, model: model || 'llama-3.3-70b-versatile', timestamp: new Date().toISOString() });
    } catch (err) {
      return res.status(502).json({ error: 'Groq LLM unavailable', details: err.message });
    }
  }

  const llmEndpoint = process.env.LLM_ENDPOINT || 'http://127.0.0.1:11434/v1/chat/completions';
  const llmModel = model || process.env.LLM_MODEL || 'qwen3:0.6b';

  try {
    const fetchMod = (await import('node-fetch')).default;
    const resp = await fetchMod(llmEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: llmModel, messages, stream: false }),
      timeout: 120000
    });
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';

    const month = new Date().toISOString().slice(0, 7);
    if (store) {
      const dispatchId = 'dsp_' + crypto.randomBytes(12).toString('hex');
      await store.createDispatch({ id: dispatchId, userId: req.user.id, agentId: 'llm-proxy', prompt: messages[messages.length - 1]?.content?.slice(0, 1000) || '', source: 'api', status: 'completed' });
      await store.incrementMonthlyUsage(req.user.id, month);
    }

    res.json({ content, model: llmModel, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(502).json({ error: 'LLM unavailable', details: err.message });
  }
});

app.post('/api/v1/waitlist', async (req, res) => {
  const { email, company, interest } = req.body;
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email required' });
  const sanitizedEmail = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitizedEmail)) return res.status(400).json({ error: 'Invalid email' });

  if (store) {
    try {
      await store.query(
        'INSERT INTO waitlist (email, company, interest, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (email) DO NOTHING',
        [sanitizedEmail, (company || '').slice(0, 255), (interest || '').slice(0, 100)]
      );
    } catch (err) {
      if (!err.message.includes('does not exist')) {
        console.error('Waitlist error:', err.message);
      }
    }
  }

  res.status(201).json({ success: true, message: 'Added to waitlist. We\'ll be in touch.' });
});

app.post('/api/v1/password-reset/request', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  let user;
  if (store) {
    user = await store.getUserByEmail(email);
  } else {
    user = Object.values(db.users).find(u => u.email === email);
  }

  if (!user) {
    return res.json({ success: true, message: 'If an account exists with this email, a reset link will be sent.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 3600000).toISOString();

  if (store) {
    try {
      await store.query(
        'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, token, expires]
      );
    } catch (err) {
      if (err.message.includes('does not exist')) {
        console.log('Password resets table not yet migrated, skipping');
      } else {
        console.error('Password reset error:', err.message);
      }
    }
  }

  res.json({ success: true, message: 'If an account exists with this email, a reset link will be sent.' });
});

app.post('/api/v1/password-reset/confirm', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Token and new password (8+ chars) required' });

  if (!store) return res.status(501).json({ error: 'Password reset requires database storage' });

  try {
    const r = await store.query(
      'SELECT * FROM password_resets WHERE token = $1 AND expires_at > NOW() AND used_at IS NULL',
      [token]
    );
    const reset = r.rows[0];
    if (!reset) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const salt = crypto.randomBytes(16);
    const hash = crypto.pbkdf2Sync(newPassword, salt, 100000, 64, 'sha512').toString('hex');

    await store.query('UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3', [hash, salt.toString('hex'), reset.user_id]);
    await store.query('UPDATE password_resets SET used_at = NOW() WHERE token = $1', [token]);
    await store.revokeApiKeysForUser(reset.user_id);

    res.json({ success: true, message: 'Password reset successfully. Please log in again.' });
  } catch (err) {
    console.error('Password reset confirm error:', err.message);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log(`Montfort API running on port ${PORT} [${store ? 'PostgreSQL' : 'In-Memory'}]`);
});

module.exports = app;
