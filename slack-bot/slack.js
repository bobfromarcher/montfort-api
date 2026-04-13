require('dotenv').config();
const { App } = require('@slack/bolt');

const API_BASE = process.env.API_BASE || 'https://api.gradeafoods.com';

const TEMPLATES = {
  moderator: {
    name: 'Moderator',
    systemPrompt: 'You are a community moderator for this Slack workspace. Enforce rules fairly, answer questions about the workspace, help new members, and de-escalate conflicts. Be firm but friendly. Remember previous conversations and user preferences.'
  },
  support: {
    name: 'Support Agent',
    systemPrompt: 'You are a customer support agent. Answer questions about the product/service, triage issues by severity, suggest solutions, and escalate when needed. Be empathetic and precise. Track ongoing issues.'
  },
  analyst: {
    name: 'Data Analyst',
    systemPrompt: 'You are a data analyst. When given data or questions, produce clear analysis with specific numbers. Identify trends, anomalies, and actionable insights. Be precise and concise.'
  },
  writer: {
    name: 'Content Writer',
    systemPrompt: 'You are a content writer. Write compelling marketing copy, announcements, blog drafts, and social media posts. Match the requested tone. Always include a clear call to action.'
  },
  researcher: {
    name: 'Research Agent',
    systemPrompt: 'You are a research analyst. Provide structured analysis covering: current state, key players, recent developments, trends, and actionable conclusions. Cite data points when possible.'
  },
  coder: {
    name: 'Code Agent',
    systemPrompt: 'You are an expert software engineer. Write clean, production-ready code. Review code for bugs and security issues. Explain your reasoning clearly. Remember codebase context.'
  },
  pm: {
    name: 'Project Manager',
    systemPrompt: 'You are a project manager. Break projects into tasks with priorities (P0/P1/P2), estimated effort, dependencies, and timelines. Identify risks early. Track project state across conversations.'
  },
  reporter: {
    name: 'Daily Reporter',
    systemPrompt: 'You are a daily reporter. Summarize information into concise, structured reports with key metrics, highlights, and action items. Format with headers and bullet points. Reference previous reports.'
  }
};

const workspaceAgents = new Map();
const conversationHistory = new Map();
const workspaceKnowledge = new Map();
const workspaceApiKeys = new Map();

const MAX_HISTORY = 50;
const MAX_HISTORY_TOKENS = 8000;
const HISTORY_EXPIRY_MS = 4 * 60 * 60 * 1000;

function getChannelHistory(channelId) {
  const hist = conversationHistory.get(channelId);
  if (!hist) return [];
  if (Date.now() - hist.lastActivity > HISTORY_EXPIRY_MS) {
    conversationHistory.delete(channelId);
    return [];
  }
  return hist.messages;
}

function pushChannelHistory(channelId, role, content, agentName) {
  if (!conversationHistory.has(channelId)) {
    conversationHistory.set(channelId, { messages: [], lastActivity: Date.now() });
  }
  const hist = conversationHistory.get(channelId);
  hist.messages.push({ role, content: String(content).slice(0, 2000), agentName, timestamp: Date.now() });
  hist.lastActivity = Date.now();
  while (hist.messages.length > MAX_HISTORY) hist.messages.shift();
}

function getWorkspaceKnowledge(teamId) {
  return workspaceKnowledge.get(teamId) || [];
}

function addWorkspaceKnowledge(teamId, text) {
  if (!workspaceKnowledge.has(teamId)) workspaceKnowledge.set(teamId, []);
  const knowledge = workspaceKnowledge.get(teamId);
  knowledge.push({ text: String(text).slice(0, 500), addedAt: Date.now() });
  if (knowledge.length > 100) knowledge.shift();
}

function buildContextMessages(teamId, channelId, systemPrompt, currentMessage, userName, selectedAgent) {
  const knowledge = getWorkspaceKnowledge(teamId);
  const history = getChannelHistory(channelId);

  let contextBlock = '';
  if (knowledge.length > 0) {
    contextBlock += '\n\n[Workspace Knowledge — things you\'ve been told to remember:]';
    for (const k of knowledge.slice(-10)) contextBlock += `\n- ${k.text}`;
  }

  const agentHistory = history.filter(m => !selectedAgent || m.agentName === selectedAgent.name);
  if (agentHistory.length > 0) {
    contextBlock += '\n\n[Recent conversation in this channel:]';
    for (const m of agentHistory.slice(-10)) {
      const who = m.role === 'user' ? `User (${userName})` : m.agentName || 'Assistant';
      contextBlock += `\n${who}: ${m.content.slice(0, 300)}`;
    }
  }

  const fullSystem = systemPrompt + contextBlock;
  const messages = [{ role: 'system', content: fullSystem }];

  for (const m of agentHistory.slice(-8)) {
    messages.push({ role: m.role, content: m.content.slice(0, 500) });
  }

  messages.push({ role: 'user', content: `[${userName}]: ${String(currentMessage).slice(0, 2000)}` });

  let totalLen = messages.reduce((s, m) => s + m.content.length, 0);
  while (totalLen > MAX_HISTORY_TOKENS && messages.length > 3) {
    messages.splice(1, 1);
    totalLen = messages.reduce((s, m) => s + m.content.length, 0);
  }

  return messages;
}

async function apiRequest(path, method, body, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: method || 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
    return await resp.json();
  } catch {
    return { error: 'API error' };
  }
}

async function callLLM(messages, apiKey) {
  if (apiKey) {
    const result = await apiRequest('/api/v1/llm', 'POST', { messages }, apiKey);
    if (result.content) return result.content;
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: process.env.LLM_MODEL || 'llama-3.3-70b-versatile',
          messages,
          stream: false,
          max_tokens: 2048
        }),
        signal: AbortSignal.timeout(60000)
      });
      const data = await resp.json();
      if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
      return `LLM error: ${data.error?.message || 'No response'}`;
    } catch (err) {
      return `Agent error: ${err.message}`;
    }
  }

  return 'No LLM configured. Set GROQ_API_KEY or connect a Montfort account.';
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: !!process.env.SLACK_APP_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN
});

app.command('/mf', async ({ command, ack, respond }) => {
  await ack();

  const teamId = command.team_id;
  const channel = command.channel_id;
  const userId = command.user_id;
  const text = command.text.trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case 'help': {
      await respond({
        text: 'Montfort Commands:',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '*Montfort Commands:*\n/mf deploy <template> — Deploy an agent\n/mf agents — List agents\n/mf remove <name> — Remove an agent\n/mf remember <text> — Teach me something\n/mf knowledge — See what I know\n/mf forget — Clear channel memory\n/mf login <api-key> — Connect account\n/mf usage — Check usage\n/mf upgrade — Upgrade plan\n/mf templates — List templates\n\n*Templates:* moderator, support, analyst, writer, researcher, coder, pm, reporter' } }
        ]
      });
      return;
    }

    case 'templates': {
      const lines = Object.entries(TEMPLATES).map(([k, v]) => `• *${k}* — ${v.name}`);
      await respond({ text: `Templates (deploy with /mf deploy <name>):\n${lines.join('\n')}` });
      return;
    }

    case 'deploy': {
      const templateName = args[0]?.toLowerCase();
      if (!templateName || !TEMPLATES[templateName]) {
        await respond('Specify a template: `/mf deploy moderator` (or support, analyst, writer, researcher, coder, pm, reporter)');
        return;
      }

      const agents = workspaceAgents.get(teamId) || [];
      if (agents.length >= 3 && !workspaceApiKeys.get(teamId)) {
        await respond('Free tier allows 3 agents. `/mf login <api-key>` to upgrade.');
        return;
      }

      const template = TEMPLATES[templateName];
      const newAgent = {
        id: 'agent-' + Date.now(),
        name: template.name,
        template: templateName,
        systemPrompt: template.systemPrompt,
        deployedAt: new Date().toISOString(),
        tasksCompleted: 0
      };

      agents.push(newAgent);
      workspaceAgents.set(teamId, agents);
      addWorkspaceKnowledge(teamId, `Agent deployed: ${template.name} (${templateName})`);

      await respond(`*${template.name} deployed!* ${agents.length}/3 agents active. Mention me to talk to your agents.`);
      return;
    }

    case 'agents': {
      const agents = workspaceAgents.get(teamId) || [];
      if (agents.length === 0) {
        await respond('No agents deployed. Use `/mf deploy <template>` to get started.');
        return;
      }
      const lines = agents.map((a, i) => `${i + 1}. *${a.name}* (${a.template}) — ${a.tasksCompleted} tasks`);
      await respond({ text: `Your Agents:\n${lines.join('\n')}` });
      return;
    }

    case 'remove': {
      const name = args[0];
      const agents = workspaceAgents.get(teamId) || [];
      const idx = agents.findIndex(a => a.name.toLowerCase() === name?.toLowerCase() || a.template === name?.toLowerCase());
      if (idx === -1) {
        await respond('Agent not found. Use `/mf agents` to see deployed agents.');
        return;
      }
      const removed = agents.splice(idx, 1)[0];
      workspaceAgents.set(teamId, agents);
      await respond(`Removed *${removed.name}*. ${agents.length} agents remaining.`);
      return;
    }

    case 'remember': {
      const textToRemember = args.join(' ');
      if (!textToRemember) {
        await respond('Usage: `/mf remember Our team uses Jira for project tracking`');
        return;
      }
      addWorkspaceKnowledge(teamId, textToRemember);
      await respond(`Got it. I'll remember: "${textToRemember.slice(0, 100)}"`);
      return;
    }

    case 'knowledge': {
      const knowledge = getWorkspaceKnowledge(teamId);
      if (knowledge.length === 0) {
        await respond('No stored knowledge yet. Use `/mf remember <text>` to teach me things.');
        return;
      }
      const lines = knowledge.slice(-15).map((k, i) => `${i + 1}. ${k.text.slice(0, 80)}`);
      await respond({ text: `Workspace Knowledge (${knowledge.length} facts):\n${lines.join('\n')}` });
      return;
    }

    case 'forget': {
      conversationHistory.delete(channel);
      await respond('Cleared conversation memory for this channel. Fresh start.');
      return;
    }

    case 'login': {
      const key = args[0];
      if (!key || !key.startsWith('mf_')) {
        await respond('Usage: `/mf login mf_your_api_key`');
        return;
      }
      const result = await apiRequest('/api/v1/usage', 'GET', null, key);
      if (result.error) {
        await respond('Invalid API key. Get yours at https://www.gradeafoods.com');
        return;
      }
      workspaceApiKeys.set(teamId, key);
      await respond(`*Account connected!* Plan: ${result.planName} | Tasks: ${result.dispatchesUsed}/${result.dispatchesLimit} | Agents: ${result.agentsUsed}/${result.agentsLimit}`);
      return;
    }

    case 'usage': {
      const apiKey = workspaceApiKeys.get(teamId);
      if (!apiKey) {
        const agents = workspaceAgents.get(teamId) || [];
        const totalTasks = agents.reduce((sum, a) => sum + a.tasksCompleted, 0);
        await respond(`Free tier: ${agents.length}/3 agents, ${totalTasks} tasks this session. \`/mf login <api-key>\` for persistent tracking.`);
        return;
      }
      const result = await apiRequest('/api/v1/usage', 'GET', null, apiKey);
      await respond(`*Usage:* Plan: ${result.planName} | Tasks: ${result.dispatchesUsed}/${result.dispatchesLimit} | Agents: ${result.agentsUsed}/${result.agentsLimit}`);
      return;
    }

    case 'upgrade': {
      const apiKey = workspaceApiKeys.get(teamId);
      if (!apiKey) {
        await respond('Connect an account first: `/mf login <api-key>`\nGet an API key at https://www.gradeafoods.com');
        return;
      }
      const result = await apiRequest('/api/v1/billing/checkout', 'POST', { plan: 'professional' }, apiKey);
      if (result.url) {
        await respond(`Upgrade to Pro ($49/mo): ${result.url}`);
      } else {
        await respond(result.message || 'Upgrade not available yet.');
      }
      return;
    }

    case 'reset': {
      workspaceAgents.delete(teamId);
      conversationHistory.delete(channel);
      workspaceKnowledge.delete(teamId);
      await respond('All agents, memory, and knowledge reset for this workspace.');
      return;
    }

    default:
      await respond('Unknown command. Try `/mf help` for available commands.');
  }
});

app.event('app_mention', async ({ event, say }) => {
  const teamId = event.team || event.team_id;
  const channel = event.channel;
  const userId = event.user;
  const content = event.text.replace(/<@[^>]+>/g, '').trim();

  if (!content) return;

  const agents = workspaceAgents.get(teamId) || [];
  if (agents.length === 0) {
    await say('No agents deployed yet! Use `/mf deploy <template>` to get started.');
    return;
  }

  let selectedAgent = agents[0];
  const lowerContent = content.toLowerCase();
  for (const agent of agents) {
    if (lowerContent.includes(agent.name.toLowerCase()) || lowerContent.includes(agent.template)) {
      selectedAgent = agent;
      break;
    }
  }

  pushChannelHistory(channel, 'user', content, null);

  const userInfo = await app.client.users.info({ user: userId }).catch(() => ({ user: { real_name: 'User' } }));
  const userName = userInfo.user?.real_name || userInfo.user?.name || 'User';

  const messages = buildContextMessages(teamId, channel, selectedAgent.systemPrompt, content, userName, selectedAgent);
  const apiKey = workspaceApiKeys.get(teamId);
  const response = await callLLM(messages, apiKey);
  selectedAgent.tasksCompleted++;

  pushChannelHistory(channel, 'assistant', response, selectedAgent.name);

  if (apiKey) {
    await apiRequest('/api/v1/dispatch', 'POST', {
      agentId: selectedAgent.id,
      prompt: content.slice(0, 2000),
      source: 'slack'
    }, apiKey).catch(() => {});
  }

  await say({
    text: response.slice(0, 3500),
    unfurl_links: false,
    unfurl_media: false
  });
});

(async () => {
  await app.start(process.env.PORT || 3200);
  console.log('Montfort Slack bot running');
})();
