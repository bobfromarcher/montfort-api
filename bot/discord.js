require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const crypto = require('crypto');

const API_BASE = process.env.API_BASE || 'http://localhost:3100';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const userApiKeys = new Map();
const serverAgents = new Map();
const conversationHistory = new Map();
const serverKnowledge = new Map();
const userProfiles = new Map();

const MAX_HISTORY_PER_CHANNEL = 50;
const MAX_HISTORY_TOKENS = 8000;
const HISTORY_EXPIRY_MS = 4 * 60 * 60 * 1000;

const TEMPLATES = {
  moderator: {
    name: 'Moderator',
    systemPrompt: 'You are a community moderator for this Discord server. Enforce rules fairly, answer questions about the community, help new members, and de-escalate conflicts. Be firm but friendly. Remember previous conversations and user preferences.'
  },
  support: {
    name: 'Support Agent',
    systemPrompt: 'You are a customer support agent. Answer questions about the product/service, triage issues by severity, suggest solutions, and escalate when needed. Be empathetic and precise. Track ongoing issues — if someone mentions a problem earlier, follow up on it later.'
  },
  analyst: {
    name: 'Data Analyst',
    systemPrompt: 'You are a data analyst. When given data or questions, produce clear analysis with specific numbers. Identify trends, anomalies, and actionable insights. Be precise and concise. Remember data points from earlier in the conversation.'
  },
  writer: {
    name: 'Content Writer',
    systemPrompt: 'You are a content writer. Write compelling marketing copy, announcements, blog drafts, and social media posts. Match the requested tone. Always include a clear call to action. Remember brand voice preferences and content from earlier requests.'
  },
  researcher: {
    name: 'Research Agent',
    systemPrompt: 'You are a research analyst. Provide structured analysis covering: current state, key players, recent developments, trends, and actionable conclusions. Cite data points when possible. Build on previous research in the conversation.'
  },
  coder: {
    name: 'Code Agent',
    systemPrompt: 'You are an expert software engineer. Write clean, production-ready code. Review code for bugs and security issues. Explain your reasoning clearly. Remember the codebase context from earlier messages — maintain consistency with previous code written.'
  },
  pm: {
    name: 'Project Manager',
    systemPrompt: 'You are a project manager. Break projects into tasks with priorities (P0/P1/P2), estimated effort, dependencies, and timelines. Identify risks early. Track project state across conversations — remember tasks discussed earlier and update status.'
  },
  reporter: {
    name: 'Daily Reporter',
    systemPrompt: 'You are a daily reporter. Summarize information into concise, structured reports with key metrics, highlights, and action items. Format with headers and bullet points. Reference previous reports for trend tracking.'
  }
};

const COMMANDS = {
  'm!help': 'Show all commands',
  'm!deploy <template>': 'Deploy an agent (moderator, support, analyst, writer, researcher, coder, pm, reporter)',
  'm!agents': 'List your deployed agents',
  'm!remove <name>': 'Remove an agent',
  'm!login <api-key>': 'Connect your Montfort account',
  'm!logout': 'Disconnect your account',
  'm!usage': 'Check your task usage and limits',
  'm!upgrade': 'Upgrade your plan',
  'm!templates': 'List available agent templates',
  'm!forget': 'Clear conversation memory in this channel',
  'm!remember <text>': 'Teach the bot something to remember for this server',
  'm!knowledge': 'See what the bot knows about this server',
  'm!reset': 'Reset all agents and memory for this server'
};

function getApiKey(guildId) {
  return userApiKeys.get(guildId) || null;
}

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
  while (hist.messages.length > MAX_HISTORY_PER_CHANNEL) hist.messages.shift();
}

function getServerKnowledge(guildId) {
  return serverKnowledge.get(guildId) || [];
}

function addServerKnowledge(guildId, text) {
  if (!serverKnowledge.has(guildId)) serverKnowledge.set(guildId, []);
  const knowledge = serverKnowledge.get(guildId);
  knowledge.push({ text: String(text).slice(0, 500), addedAt: Date.now() });
  if (knowledge.length > 100) knowledge.shift();
}

function getUserProfile(userId) {
  return userProfiles.get(userId) || { messageCount: 0, topics: [], lastSeen: 0 };
}

function updateUserProfile(userId, content) {
  if (!userProfiles.has(userId)) userProfiles.set(userId, { messageCount: 0, topics: [], lastSeen: 0 });
  const profile = userProfiles.get(userId);
  profile.messageCount++;
  profile.lastSeen = Date.now();
  const words = content.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  for (const w of words.slice(0, 3)) {
    if (!profile.topics.includes(w) && profile.topics.length < 20) profile.topics.push(w);
  }
}

function buildContextMessages(guildId, channelId, systemPrompt, currentMessage, authorTag, selectedAgent) {
  const knowledge = getServerKnowledge(guildId);
  const history = getChannelHistory(channelId);

  let contextBlock = '';
  if (knowledge.length > 0) {
    contextBlock += '\n\n[Server Knowledge — things you\'ve been told to remember:]';
    for (const k of knowledge.slice(-10)) contextBlock += `\n- ${k.text}`;
  }

  const agentHistory = history.filter(m => !selectedAgent || m.agentName === selectedAgent.name);
  if (agentHistory.length > 0) {
    contextBlock += '\n\n[Recent conversation in this channel:]';
    for (const m of agentHistory.slice(-10)) {
      const who = m.role === 'user' ? `User (${authorTag})` : m.agentName || 'Assistant';
      contextBlock += `\n${who}: ${m.content.slice(0, 300)}`;
    }
  }

  const fullSystem = systemPrompt + contextBlock;

  const messages = [{ role: 'system', content: fullSystem }];

  for (const m of agentHistory.slice(-8)) {
    messages.push({ role: m.role, content: m.content.slice(0, 500) });
  }

  messages.push({ role: 'user', content: `[${authorTag}]: ${String(currentMessage).slice(0, 2000)}` });

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

  const endpoint = process.env.LLM_ENDPOINT || 'http://127.0.0.1:11434/v1/chat/completions';
  const model = process.env.LLM_MODEL || 'qwen3:0.6b';
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: AbortSignal.timeout(120000)
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || 'No response.';
  } catch (err) {
    return `Agent error: ${err.message}`;
  }
}

client.once('ready', async () => {
  console.log(`Montfort Bot online as ${client.user.tag}`);
  console.log(`Serving ${client.guilds.cache.size} servers`);
  client.user.setActivity('m!help to get started', { type: 2 });

  setInterval(() => {
    const now = Date.now();
    for (const [chId, hist] of conversationHistory) {
      if (now - hist.lastActivity > HISTORY_EXPIRY_MS) conversationHistory.delete(chId);
    }
  }, 30 * 60 * 1000);
});

client.on('guildCreate', async (guild) => {
  console.log(`Joined guild: ${guild.name} (${guild.id})`);
  addServerKnowledge(guild.id, `Server name: ${guild.name}, Member count: ${guild.memberCount}`);

  let channel = guild.systemChannelId
    ? guild.channels.cache.get(guild.systemChannelId)
    : guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages));

  if (channel) {
    const embed = new EmbedBuilder()
      .setTitle('Montfort — Your AI Team Has Arrived')
      .setDescription(
        'I\'m your AI agent platform. Deploy agents that work right here in your server.\n\n' +
        '**Quick start:**\n' +
        '1. `m!templates` — See available agents\n' +
        '2. `m!deploy moderator` — Deploy your first agent\n' +
        '3. `@Montfort <your question>` — Talk to your agent\n\n' +
        '**I remember conversations.** I learn about your server over time.\n' +
        '`m!remember <text>` — Teach me something.\n\n' +
        'Free tier: 3 agents, 1,000 tasks/month. No credit card.'
      )
      .setColor(0x4ade80)
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  }
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;

  const isMention = msg.mentions.has(client.user);
  const isCommand = msg.content.startsWith('m!');

  if (!isMention && !isCommand) {
    if (msg.guild) {
      pushChannelHistory(msg.channel.id, 'ambient', `${msg.author.tag}: ${msg.content}`, null);
    }
    return;
  }

  const content = msg.content.replace(/<@!?\d+>/g, '').replace(/^m!/, '').trim();
  const guildId = msg.guild.id;
  const channelId = msg.channel.id;
  const authorTag = msg.author.tag;
  const userId = msg.author.id;

  updateUserProfile(userId, content);

  if (isCommand) {
    const parts = content.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'help': {
        const lines = Object.entries(COMMANDS).map(([k, v]) => `**${k}** — ${v}`);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Montfort Commands')
          .setDescription(lines.join('\n'))
          .setColor(0xb8860b)
          .setFooter({ text: 'Free tier: 3 agents, 1,000 tasks/month | I remember conversations!' })
        ]});
        return;
      }

      case 'templates': {
        const lines = Object.entries(TEMPLATES).map(([k, v]) => `**${k}** — ${v.name}`);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Agent Templates')
          .setDescription('Deploy with `m!deploy <name>`\n\n' + lines.join('\n'))
          .setColor(0x4ade80)
        ]});
        return;
      }

      case 'deploy': {
        const templateName = args[0]?.toLowerCase();
        if (!templateName || !TEMPLATES[templateName]) {
          await msg.reply('Specify a template: `m!deploy moderator` (or support, analyst, writer, researcher, coder, pm, reporter)');
          return;
        }

        const agents = serverAgents.get(guildId) || [];
        if (agents.length >= 3 && !getApiKey(guildId)) {
          await msg.reply('Free tier allows 3 agents. `m!login <api-key>` to connect your account and upgrade.');
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
        serverAgents.set(guildId, agents);

        const apiKey = getApiKey(guildId);
        if (apiKey) {
          await apiRequest('/api/v1/agents', 'POST', {
            name: newAgent.name,
            endpoint: process.env.LLM_ENDPOINT || 'http://127.0.0.1:11434/v1/chat/completions',
            model: process.env.LLM_MODEL || 'qwen3:0.6b',
            systemPrompt: newAgent.systemPrompt
          }, apiKey);
        }

        addServerKnowledge(guildId, `Agent deployed: ${template.name} (${templateName})`);

        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle(`${template.name} Deployed`)
          .setDescription(`Now active in this server. Mention me (@Montfort) to talk to your agents.\nI remember conversations in each channel.`)
          .setColor(0x4ade80)
          .addFields({ name: 'Template', value: templateName, inline: true }, { name: 'Agents', value: `${agents.length}/3 (free)`, inline: true })
        ]});
        return;
      }

      case 'agents': {
        const agents = serverAgents.get(guildId) || [];
        if (agents.length === 0) {
          await msg.reply('No agents deployed yet. Use `m!deploy <template>` to get started.');
          return;
        }
        const lines = agents.map((a, i) => `**${i + 1}. ${a.name}** (${a.template}) — ${a.tasksCompleted} tasks completed`);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Your Agents')
          .setDescription(lines.join('\n'))
          .setColor(0xb8860b)
        ]});
        return;
      }

      case 'remove': {
        const name = args[0];
        const agents = serverAgents.get(guildId) || [];
        const idx = agents.findIndex(a => a.name.toLowerCase() === name?.toLowerCase() || a.template === name?.toLowerCase());
        if (idx === -1) {
          await msg.reply('Agent not found. Use `m!agents` to see deployed agents.');
          return;
        }
        const removed = agents.splice(idx, 1)[0];
        serverAgents.set(guildId, agents);
        await msg.reply(`Removed **${removed.name}**. ${agents.length} agents remaining.`);
        return;
      }

      case 'login': {
        const key = args[0];
        if (!key || !key.startsWith('mf_')) {
          await msg.reply('Usage: `m!login mf_your_api_key` (DM this for security)');
          return;
        }
        const result = await apiRequest('/api/v1/usage', 'GET', null, key);
        if (result.error) {
          await msg.reply('Invalid API key. Get yours at https://www.gradeafoods.com');
          return;
        }
        userApiKeys.set(guildId, key);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Account Connected')
          .setDescription(`Plan: **${result.planName}**\nTasks: ${result.dispatchesUsed}/${result.dispatchesLimit}\nAgents: ${result.agentsUsed}/${result.agentsLimit}`)
          .setColor(0x4ade80)
        ]});
        return;
      }

      case 'logout': {
        userApiKeys.delete(guildId);
        await msg.reply('Account disconnected. You\'re on the free tier.');
        return;
      }

      case 'usage': {
        const apiKey = getApiKey(guildId);
        if (!apiKey) {
          const agents = serverAgents.get(guildId) || [];
          const totalTasks = agents.reduce((sum, a) => sum + a.tasksCompleted, 0);
          await msg.reply(`Free tier: ${agents.length}/3 agents, ${totalTasks} tasks used this session. Connect an account for persistent tracking: \`m!login <api-key>\``);
          return;
        }
        const result = await apiRequest('/api/v1/usage', 'GET', null, apiKey);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Usage')
          .setDescription(`Plan: **${result.planName}**\nTasks: ${result.dispatchesUsed}/${result.dispatchesLimit}\nAgents: ${result.agentsUsed}/${result.agentsLimit}`)
          .setColor(0xb8860b)
        ]});
        return;
      }

      case 'upgrade': {
        const apiKey = getApiKey(guildId);
        if (!apiKey) {
          await msg.reply('Connect an account first: `m!login <api-key>`\nGet an API key at https://www.gradeafoods.com');
          return;
        }
        const result = await apiRequest('/api/v1/billing/checkout', 'POST', { plan: 'professional' }, apiKey);
        if (result.url) {
          await msg.reply(`Upgrade to Pro ($49/mo — unlimited agents, 50K tasks): ${result.url}`);
        } else {
          await msg.reply(result.message || 'Upgrade not available yet.');
        }
        return;
      }

      case 'forget': {
        conversationHistory.delete(channelId);
        await msg.reply('Cleared conversation memory for this channel. Fresh start.');
        return;
      }

      case 'remember': {
        const text = args.join(' ');
        if (!text) {
          await msg.reply('Usage: `m!remember Our team uses Jira for project tracking`');
          return;
        }
        addServerKnowledge(guildId, text);
        await msg.reply(`Got it. I'll remember: "${text.slice(0, 100)}"`);
        return;
      }

      case 'knowledge': {
        const knowledge = getServerKnowledge(guildId);
        if (knowledge.length === 0) {
          await msg.reply('I don\'t have any stored knowledge yet. Use `m!remember <text>` to teach me things.');
          return;
        }
        const lines = knowledge.slice(-15).map((k, i) => `${i + 1}. ${k.text.slice(0, 80)}`);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Server Knowledge')
          .setDescription(lines.join('\n'))
          .setColor(0xb8860b)
          .setFooter({ text: `${knowledge.length} facts stored` })
        ]});
        return;
      }

      case 'reset': {
        serverAgents.delete(guildId);
        conversationHistory.delete(channelId);
        serverKnowledge.delete(guildId);
        await msg.reply('All agents, memory, and knowledge for this server have been reset.');
        return;
      }

      default:
        await msg.reply('Unknown command. Type `m!help` for available commands.');
        return;
    }
  }

  if (isMention && content) {
    const agents = serverAgents.get(guildId) || [];
    if (agents.length === 0) {
      await msg.reply('No agents deployed yet! Use `m!deploy <template>` to get started. Try `m!deploy moderator`');
      return;
    }

    await msg.channel.sendTyping();

    let selectedAgent = agents[0];
    const lowerContent = content.toLowerCase();
    for (const agent of agents) {
      if (lowerContent.includes(agent.name.toLowerCase()) || lowerContent.includes(agent.template)) {
        selectedAgent = agent;
        break;
      }
    }

    pushChannelHistory(channelId, 'user', content, null);

    const messages = buildContextMessages(guildId, channelId, selectedAgent.systemPrompt, content, authorTag, selectedAgent);
    const apiKey = getApiKey(guildId);
    const response = await callLLM(messages, apiKey);
    selectedAgent.tasksCompleted++;

    pushChannelHistory(channelId, 'assistant', response, selectedAgent.name);

    if (apiKey) {
      await apiRequest('/api/v1/dispatch', 'POST', {
        agentId: selectedAgent.id,
        prompt: content.slice(0, 2000),
        source: 'discord'
      }, apiKey).catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setTitle(selectedAgent.name)
      .setDescription(response.slice(0, 4096))
      .setColor(0x4ade80)
      .setFooter({ text: `Montfort • Task #${selectedAgent.tasksCompleted} • I remember this conversation` })
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
  }
});

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error('DISCORD_BOT_TOKEN required');
  process.exit(1);
}

client.login(TOKEN);
