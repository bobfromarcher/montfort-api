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

const TEMPLATES = {
  moderator: {
    name: 'Moderator',
    systemPrompt: 'You are a community moderator. Enforce rules fairly, answer questions about the community, help new members, and de-escalate conflicts. Be firm but friendly.'
  },
  support: {
    name: 'Support Agent',
    systemPrompt: 'You are a customer support agent. Answer questions about the product/service, triage issues by severity, suggest solutions, and escalate when needed. Be empathetic and precise.'
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
    systemPrompt: 'You are an expert software engineer. Write clean, production-ready code. Review code for bugs and security issues. Explain your reasoning clearly.'
  },
  pm: {
    name: 'Project Manager',
    systemPrompt: 'You are a project manager. Break projects into tasks with priorities (P0/P1/P2), estimated effort, dependencies, and timelines. Identify risks early.'
  },
  reporter: {
    name: 'Daily Reporter',
    systemPrompt: 'You are a daily reporter. Summarize information into concise, structured reports with key metrics, highlights, and action items. Format with headers and bullet points.'
  }
};

const COMMANDS = {
  '/help': 'Show all commands',
  '/deploy <template>': 'Deploy an agent (moderator, support, analyst, writer, researcher, coder, pm, reporter)',
  '/agents': 'List your deployed agents',
  '/remove <name>': 'Remove an agent',
  '/login <api-key>': 'Connect your Montfort account for billing & cloud sync',
  '/logout': 'Disconnect your account',
  '/usage': 'Check your task usage and limits',
  '/upgrade': 'Get a link to upgrade your plan',
  '/templates': 'List available agent templates'
};

function getApiKey(guildId) {
  return userApiKeys.get(guildId) || null;
}

async function apiRequest(path, method, body, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const resp = await fetch(`${API_BASE}${path}`, {
    method: method || 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    timeout: 30000
  });
  return resp.json().catch(() => ({ error: 'API error' }));
}

async function callLLM(systemPrompt, userMessage, apiKey) {
  if (apiKey) {
    const result = await apiRequest('/api/v1/llm', 'POST', {
      messages: [
        { role: 'system', content: systemPrompt + '\n\nRespond concisely. If you don\'t know, say so. Be helpful and direct.' },
        { role: 'user', content: String(userMessage).slice(0, 4000) }
      ]
    }, apiKey);
    if (result.content) return result.content;
    return result.error || 'Agent error. Try again.';
  }

  const endpoint = process.env.LLM_ENDPOINT || 'http://127.0.0.1:11434/v1/chat/completions';
  const model = process.env.LLM_MODEL || 'qwen3:0.6b';

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt + '\n\nRespond concisely. If you don\'t know, say so. Be helpful and direct.' },
          { role: 'user', content: String(userMessage).slice(0, 4000) }
        ],
        stream: false
      }),
      timeout: 120000
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || 'I couldn\'t generate a response. Please try again.';
  } catch (err) {
    return `Agent error: ${err.message}`;
  }
}

client.once('ready', async () => {
  console.log(`Montfort Bot online as ${client.user.tag}`);
  console.log(`Serving ${client.guilds.cache.size} servers`);

  client.user.setActivity('Type /help to get started', { type: 2 });
});

client.on('guildCreate', async (guild) => {
  console.log(`Joined guild: ${guild.name} (${guild.id})`);

  let channel = guild.systemChannelId
    ? guild.channels.cache.get(guild.systemChannelId)
    : guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages));

  if (channel) {
    const embed = new EmbedBuilder()
      .setTitle('Montfort — Your AI Team Has Arrived')
      .setDescription(
        'I\'m your AI agent platform. Deploy agents that work right here in your server.\n\n' +
        '**Quick start:**\n' +
        '1. `/templates` — See available agents\n' +
        '2. `/deploy moderator` — Deploy your first agent\n' +
        '3. `@Montfort <your question>` — Talk to your agent\n\n' +
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
  const isCommand = msg.content.startsWith('/');

  if (!isMention && !isCommand) return;

  const content = msg.content.replace(/<@!?\d+>/g, '').trim();
  const guildId = msg.guild.id;

  if (isCommand) {
    const parts = content.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case '/help': {
        const lines = Object.entries(COMMANDS).map(([k, v]) => `**${k}** — ${v}`);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Montfort Commands')
          .setDescription(lines.join('\n'))
          .setColor(0xb8860b)
          .setFooter({ text: 'Free tier: 3 agents, 1,000 tasks/month' })
        ]});
        return;
      }

      case '/templates': {
        const lines = Object.entries(TEMPLATES).map(([k, v]) => `**${k}** — ${v.name}: ${v.systemPrompt.split('.')[0]}`);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Agent Templates')
          .setDescription('Deploy with `/deploy <name>`\n\n' + lines.join('\n'))
          .setColor(0x4ade80)
        ]});
        return;
      }

      case '/deploy': {
        const templateName = args[0]?.toLowerCase();
        if (!templateName || !TEMPLATES[templateName]) {
          await msg.reply('Specify a template: `/deploy moderator` (or support, analyst, writer, researcher, coder, pm, reporter)');
          return;
        }

        const agents = serverAgents.get(guildId) || [];
        if (agents.length >= 3 && !getApiKey(guildId)) {
          await msg.reply('Free tier allows 3 agents. `/login <api-key>` to connect your account and upgrade.');
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

        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle(`${template.name} Deployed`)
          .setDescription(`Now active in this server. Mention me (@Montfort) to talk to your agents.`)
          .setColor(0x4ade80)
          .addFields({ name: 'Template', value: templateName, inline: true }, { name: 'Agents', value: `${agents.length}/3 (free)`, inline: true })
        ]});
        return;
      }

      case '/agents': {
        const agents = serverAgents.get(guildId) || [];
        if (agents.length === 0) {
          await msg.reply('No agents deployed yet. Use `/deploy <template>` to get started.');
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

      case '/remove': {
        const name = args[0];
        const agents = serverAgents.get(guildId) || [];
        const idx = agents.findIndex(a => a.name.toLowerCase() === name?.toLowerCase() || a.template === name?.toLowerCase());
        if (idx === -1) {
          await msg.reply('Agent not found. Use `/agents` to see deployed agents.');
          return;
        }
        const removed = agents.splice(idx, 1)[0];
        serverAgents.set(guildId, agents);
        await msg.reply(`Removed **${removed.name}**. ${agents.length} agents remaining.`);
        return;
      }

      case '/login': {
        const key = args[0];
        if (!key || !key.startsWith('mf_')) {
          await msg.reply('Usage: `/login mf_your_api_key` (DM this for security)');
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

      case '/logout': {
        userApiKeys.delete(guildId);
        await msg.reply('Account disconnected. You\'re on the free tier.');
        return;
      }

      case '/usage': {
        const apiKey = getApiKey(guildId);
        if (!apiKey) {
          const agents = serverAgents.get(guildId) || [];
          const totalTasks = agents.reduce((sum, a) => sum + a.tasksCompleted, 0);
          await msg.reply(`Free tier: ${agents.length}/3 agents, ${totalTasks} tasks used this session. Connect an account for persistent tracking: \`/login <api-key>\``);
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

      case '/upgrade': {
        const apiKey = getApiKey(guildId);
        if (!apiKey) {
          await msg.reply('Connect an account first: `/login <api-key>`\nGet an API key at https://www.gradeafoods.com');
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

      default:
        await msg.reply('Unknown command. Type `/help` for available commands.');
        return;
    }
  }

  if (isMention && content) {
    const agents = serverAgents.get(guildId) || [];
    if (agents.length === 0) {
      await msg.reply('No agents deployed yet! Use `/deploy <template>` to get started. Try `/deploy moderator`');
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

    const apiKey = getApiKey(guildId);
    const response = await callLLM(selectedAgent.systemPrompt, content, apiKey);
    selectedAgent.tasksCompleted++;

    const apiKey = getApiKey(guildId);
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
      .setFooter({ text: `Montfort • Task #${selectedAgent.tasksCompleted}` })
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
