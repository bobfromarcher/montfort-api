require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const crypto = require('crypto');

const API_BASE = process.env.API_BASE || 'http://localhost:3100';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ]
});

const userApiKeys = new Map();
const serverAgents = new Map();
const conversationHistory = new Map();
const serverKnowledge = new Map();
const userProfiles = new Map();
const scheduledTasks = new Map();
const watchKeywords = new Map();

const INVITE_URL = 'https://discord.com/oauth2/authorize?client_id=1067608639877161031&permissions=562952101021760&integration_type=0&scope=bot+applications.commands';

const C = {
  amber: 0xc9a227,
  amberLight: 0xe2c064,
  cream: 0xf5f0e8,
  sage: 0x7ab87a,
  coral: 0xd4553a,
  slate: 0x6b7c94,
  lavender: 0x9b8ec4,
  surface: 0x1c1c22,
  bg: 0x0c0c0e
};

const BRAND = 'Montfort';

function sanitize(str) {
  return String(str).replace(/[@<>#[\]]/g, '').slice(0, 2000);
}

const cooldowns = new Map();
const COOLDOWN_MS = 3000;

function checkCooldown(userId, cmd) {
  const key = `${userId}:${cmd}`;
  const now = Date.now();
  const last = cooldowns.get(key) || 0;
  if (now - last < COOLDOWN_MS) return false;
  cooldowns.set(key, now);
  return true;
}

const activeTrivia = new Map();
const activePolls = new Map();
const reminders = new Map();

const MAX_HISTORY_PER_CHANNEL = 50;
const MAX_HISTORY_TOKENS = 8000;
const HISTORY_EXPIRY_MS = 4 * 60 * 60 * 1000;

const FUN = {
  eightball: [
    'It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes definitely.',
    'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.',
    'Yes.', 'Signs point to yes.', 'Reply hazy, try again.', 'Ask again later.',
    'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.',
    "Don't count on it.", 'My reply is no.', 'My sources say no.', 'Outlook not so good.',
    'Very doubtful.', 'Absolutely not.', 'No chance.', '100% yes.', 'Hell yeah.',
    'In your dreams.', 'Only on Tuesdays.', 'The stars say no.'
  ],
  facts: [
    'Honey never spoils. Archaeologists found 3000-year-old honey in Egyptian tombs that was still edible.',
    'A group of flamingos is called a "flamboyance".',
    'Octopuses have three hearts and blue blood.',
    'Bananas are berries, but strawberries are not.',
    'A jiffy is an actual unit of time — 1/100th of a second.',
    'Sharks existed before trees. Sharks are ~400M years old; trees are ~350M.',
    'The shortest war in history was between Britain and Zanzibar in 1896 — it lasted 38 minutes.',
    'A day on Venus is longer than a year on Venus.',
    "Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid.",
    'There are more possible iterations of a game of chess than atoms in the observable universe.',
    'Wombat poop is cube-shaped.',
    'A blue whale\'s heart is so big a small child could swim through its arteries.',
    'The unicorn is the national animal of Scotland.',
    'An ostrich\'s eye is bigger than its brain.',
    'The first website ever created is still online: info.cern.ch.',
    'There are about 3.04 trillion trees on Earth — 422 for every person.',
    "The world's oldest known living tree is over 5,000 years old.",
    'Cows have best friends and get stressed when separated.',
    'A total solar eclipse happens somewhere on Earth roughly every 18 months.',
    'The first computer bug was an actual bug — a moth found in a Harvard computer in 1947.'
  ],
  wyr: [
    'Would you rather have unlimited money or unlimited time?',
    'Would you rather always be 10 minutes late or 20 minutes early?',
    'Would you rather have internet that never goes down or a phone that never runs out of battery?',
    'Would you rather be able to fly or be invisible?',
    'Would you rather have rewind or pause on your life?',
    'Would you rather know the date of your death or the cause?',
    'Would you rather only be able to whisper or only be able to shout?',
    'Would you rather have a personal chef or a personal trainer?',
    'Would you rather live in the Matrix or the real world?',
    'Would you rather never use social media again or never watch another movie?',
    'Would you rather have a rewind button for your life or a pause button?',
    'Would you rather fight one horse-sized duck or 100 duck-sized horses?',
    'Would you rather always know when someone is lying or always get away with lying?',
    'Would you rather have free WiFi wherever you go or free coffee wherever you go?',
    'Would you rather be famous for something embarrassing or unknown but accomplished?',
    'Would you rather give up all streaming services or all video games?',
    'Would you rather only eat pizza or never eat pizza again?',
    'Would you rather have a boring job that pays $500K or a fun job that pays $50K?'
  ],
  roasts: [
    "You're like a cloud. When you disappear, it's a beautiful day.",
    "I'd agree with you but then we'd both be wrong.",
    "You bring everyone so much joy when you leave the room.",
    "You're not stupid, you just have bad luck thinking.",
    "I'm not saying you're dumb, but you could be outsmarted by a houseplant.",
    "You have your whole life to be a menace. Why not take today off?",
    "Your face is fine but your personality needs an update.",
    "You're the reason the gene pool needs a lifeguard.",
    "I'd roast you but it looks like life already beat me to it.",
    "You're like the first slice of bread — everyone touches you but nobody wants you.",
    "If you were any more boring you'd be a PowerPoint presentation.",
    "You're not the dumbest person on Earth, but you better hope they don't die.",
    "Somewhere out there, a village is missing its idiot.",
    "You have the personality of a wet napkin.",
    "I envy people who've never met you."
  ],
  compliments: [
    "You're the kind of person who makes the room better just by being in it.",
    "Your energy is contagious in the best way.",
    "You give off main character vibes.",
    "You're smarter than you give yourself credit for.",
    "The world is luckier because you're in it.",
    "You have impeccable taste and it shows.",
    "Your confidence inspires everyone around you.",
    "You're proof that good people still exist.",
    "You somehow make chaos look organized.",
    "Your vibe is immaculate.",
    "Everyone's day gets better when you show up.",
    "You're the friend everyone wishes they had.",
    "Your creativity is unmatched.",
    "You carry yourself like someone who knows their worth.",
    "You're a walking good idea."
  ],
  trivia: [
    { q: "What planet is known as the Red Planet?", a: "Mars", options: ["Venus", "Mars", "Jupiter", "Saturn"] },
    { q: "What is the largest ocean on Earth?", a: "Pacific", options: ["Atlantic", "Indian", "Pacific", "Arctic"] },
    { q: "How many hearts does an octopus have?", a: "3", options: ["1", "2", "3", "4"] },
    { q: "What is the chemical symbol for gold?", a: "Au", options: ["Go", "Au", "Ag", "Gd"] },
    { q: "Which country has the most islands?", a: "Sweden", options: ["Indonesia", "Sweden", "Philippines", "Canada"] },
    { q: "What year was the first iPhone released?", a: "2007", options: ["2005", "2006", "2007", "2008"] },
    { q: "What is the smallest country in the world?", a: "Vatican City", options: ["Monaco", "Vatican City", "Nauru", "San Marino"] },
    { q: "How many bones does an adult human have?", a: "206", options: ["195", "206", "213", "221"] },
    { q: "What is the longest river in the world?", a: "Nile", options: ["Amazon", "Nile", "Mississippi", "Yangtze"] },
    { q: "Which element has the chemical symbol 'O'?", a: "Oxygen", options: ["Osmium", "Oxygen", "Oganesson", "Gold"] },
    { q: "What is the speed of light in km/s (approx)?", a: "300,000", options: ["150,000", "300,000", "450,000", "600,000"] },
    { q: "Who painted the Mona Lisa?", a: "Leonardo da Vinci", options: ["Michelangelo", "Leonardo da Vinci", "Raphael", "Donatello"] },
    { q: "What is the hardest natural substance?", a: "Diamond", options: ["Quartz", "Diamond", "Topaz", "Sapphire"] },
    { q: "Which planet has the most moons?", a: "Saturn", options: ["Jupiter", "Saturn", "Uranus", "Neptune"] },
    { q: "What is the capital of Japan?", a: "Tokyo", options: ["Kyoto", "Osaka", "Tokyo", "Hiroshima"] },
    { q: "What programming language was created by Brendan Eich in 10 days?", a: "JavaScript", options: ["Python", "Java", "JavaScript", "Ruby"] },
    { q: "What does CPU stand for?", a: "Central Processing Unit", options: ["Central Processing Unit", "Computer Personal Utility", "Central Program Upgrade", "Core Processing Utility"] },
    { q: "What year was GitHub founded?", a: "2008", options: ["2006", "2007", "2008", "2010"] },
    { q: "What does HTTP stand for?", a: "HyperText Transfer Protocol", options: ["HyperText Transfer Protocol", "High Tech Transfer Protocol", "HyperText Transmission Process", "High Transfer Text Protocol"] },
    { q: "Which company created the Python programming language's name reference?", a: "Monty Python", options: ["Monty Python", "Python Software Foundation", "Google", "Microsoft"] },
    { q: "What is the most-used programming language as of 2024?", a: "Python", options: ["Java", "Python", "JavaScript", "C++"] },
    { q: "What does RAM stand for?", a: "Random Access Memory", options: ["Random Access Memory", "Read Access Module", "Rapid Application Memory", "Run Access Mode"] },
    { q: "Who is considered the father of the computer?", a: "Charles Babbage", options: ["Alan Turing", "Charles Babbage", "John von Neumann", "Ada Lovelace"] },
    { q: "What does API stand for?", a: "Application Programming Interface", options: ["Application Programming Interface", "Advanced Protocol Integration", "Automated Process Instruction", "Application Process Integration"] }
  ]
};

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

const COMMANDS_FUN = {
  'm!8ball <question>': 'Ask the Magic 8-Ball',
  'm!trivia': 'Random trivia — answer for glory',
  'm!fact': 'Random fun fact',
  'm!roast [@user]': 'Roast someone (or yourself)',
  'm!compliment [@user]': 'Brighten someone\'s day',
  'm!wyr': 'Would You Rather',
  'm!poll <question>': 'Quick reaction poll',
  'm!define <word>': 'Get a definition',
  'm!summarize': 'Catch up on missed messages',
  'm!remind <time> <text>': 'Set a reminder (e.g. m!remind 30m Take pizza out)',
  'm!invite': 'Get the link to add Montfort to another server',
  'm!stats': 'See bot stats and server count'
};

const COMMANDS_AGENTS = {
  'm!deploy <template>': 'Deploy an agent (moderator, support, analyst, writer, researcher, coder, pm, reporter)',
  'm!agents': 'List your deployed agents',
  'm!remove <name>': 'Remove an agent',
  'm!templates': 'List available agent templates',
  'm!ask <question>': 'Smart ask — auto-picks the best agent'
};

const COMMANDS_MEMORY = {
  'm!forget': 'Clear conversation memory in this channel',
  'm!remember <text>': 'Teach the bot something to remember',
  'm!knowledge': 'See what the bot knows about this server',
  'm!reset': 'Reset all agents and memory for this server'
};

const COMMANDS_ACCOUNT = {
  'm!login <api-key>': 'Connect your Montfort account',
  'm!logout': 'Disconnect your account',
  'm!usage': 'Check your task usage and limits',
  'm!upgrade': 'Upgrade your plan',
  'm!schedule <time> <prompt>': 'Schedule a recurring task',
  'm!schedules': 'List scheduled tasks',
  'm!unschedule <id>': 'Remove a scheduled task',
  'm!watch <keyword>': 'Auto-respond when keyword appears',
  'm!unwatch <keyword>': 'Stop watching a keyword',
  'm!watches': 'List watched keywords'
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

  const agentHistory = history.filter(m => !selectedAgent || m.agentName === selectedAgent.name || m.agentName === null);
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

function pickBestAgent(agents, query) {
  if (agents.length === 0) return null;
  if (agents.length === 1) return agents[0];

  const q = query.toLowerCase();
  const scores = agents.map(agent => {
    let score = 0;
    const template = agent.template;
    const name = agent.name.toLowerCase();

    if (template === 'coder' || name.includes('code')) {
      if (/code|bug|debug|function|api|error|fix|implement|deploy|build|test|review/i.test(q)) score += 10;
    }
    if (template === 'support' || name.includes('support')) {
      if (/help|issue|ticket|problem|broken|can't|doesn't|won't|how do|how to|trouble/i.test(q)) score += 10;
    }
    if (template === 'analyst' || name.includes('analyst')) {
      if (/data|number|metric|stat|analytics|report|chart|trend|insight|measure/i.test(q)) score += 10;
    }
    if (template === 'writer' || name.includes('writer') || name.includes('content')) {
      if (/write|draft|blog|post|email|copy|announce|content|marketing|headline/i.test(q)) score += 10;
    }
    if (template === 'researcher' || name.includes('research')) {
      if (/research|find|search|investigate|compare|analyze|who|what is|explain/i.test(q)) score += 10;
    }
    if (template === 'moderator' || name.includes('moderator')) {
      if (/rule|ban|kick|warn|moderate|community|member|welcome|introduce/i.test(q)) score += 10;
    }
    if (template === 'pm' || name.includes('project') || name.includes('manager')) {
      if (/plan|schedule|task|project|priority|timeline|deadline|sprint|roadmap/i.test(q)) score += 10;
    }
    if (template === 'reporter' || name.includes('report')) {
      if (/summarize|summary|report|daily|weekly|standup|brief|digest|recap/i.test(q)) score += 10;
    }

    if (q.includes(name)) score += 5;
    if (q.includes(template)) score += 5;

    score += Math.random() * 0.5;
    return { agent, score };
  });

  scores.sort((a, b) => b.score - a.score);
  return scores[0].score > 1 ? scores[0].agent : agents[0];
}

function parseScheduleTime(timeStr) {
  const t = timeStr.toLowerCase().trim();
  const match = t.match(/^(\d{1,2})(am|pm)?$/);
  if (match) {
    let hour = parseInt(match[1]);
    if (match[2] === 'pm' && hour < 12) hour += 12;
    if (match[2] === 'am' && hour === 12) hour = 0;
    return { hour, minute: 0 };
  }
  const matchH = t.match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
  if (matchH) {
    let hour = parseInt(matchH[1]);
    let minute = parseInt(matchH[2]);
    if (matchH[3] === 'pm' && hour < 12) hour += 12;
    if (matchH[3] === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }
  return null;
}

setInterval(async () => {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const dayOfWeek = now.getDay();

  for (const [guildId, tasks] of scheduledTasks) {
    const agents = serverAgents.get(guildId) || [];
    if (agents.length === 0) continue;

    for (const task of tasks) {
      if (!task.enabled) continue;
      if (task.lastRunDate === now.toDateString()) continue;
      if (task.time.hour !== currentHour || task.time.minute !== currentMinute) continue;
      if (task.weekdaysOnly && (dayOfWeek === 0 || dayOfWeek === 6)) continue;

      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const channel = guild.channels.cache.get(task.channelId);
      if (!channel || !channel.isTextBased()) continue;

      task.lastRunDate = now.toDateString();

      const agent = agents[0];
      pushChannelHistory(task.channelId, 'user', `[Scheduled: ${task.label}] ${task.prompt}`, null);

      const messages = buildContextMessages(guildId, task.channelId, agent.systemPrompt, task.prompt, 'Scheduler', agent);
      const apiKey = getApiKey(guildId);
      const response = await callLLM(messages, apiKey);
      agent.tasksCompleted++;

      pushChannelHistory(task.channelId, 'assistant', response, agent.name);

      const embed = new EmbedBuilder()
        .setTitle(`${agent.name} — Scheduled`)
        .setDescription(response.slice(0, 4096))
        .setColor(C.amber)
        .setFooter({ text: `Scheduled task: ${task.label}` })
        .setTimestamp();

      try { await channel.send({ embeds: [embed] }); } catch {}
    }
  }
}, 60000);

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

  const presences = [
    { name: 'm!help to get started', type: 2 },
    { name: 'm!8ball for Magic 8-Ball', type: 0 },
    { name: 'm!trivia — test your knowledge', type: 0 },
    { name: `with ${client.guilds.cache.size} servers`, type: 0 }
  ];
  let pIdx = 0;
  client.user.setActivity(presences[0]);

  setInterval(() => {
    pIdx = (pIdx + 1) % presences.length;
    client.user.setActivity(presences[pIdx]);
  }, 5 * 60 * 1000);

  setInterval(() => {
    const now = Date.now();
    for (const [chId, hist] of conversationHistory) {
      if (now - hist.lastActivity > HISTORY_EXPIRY_MS) conversationHistory.delete(chId);
    }
  }, 30 * 60 * 1000);
});

client.on('guildCreate', async (guild) => {
  console.log(`Joined guild: ${guild.name} (${guild.id})`);

  const generalAgent = {
    id: 'agent-auto-' + Date.now(),
    name: 'General',
    template: 'moderator',
    systemPrompt: 'You are a helpful, friendly AI assistant in this Discord server. Be concise, fun, and helpful. Remember previous conversations and user preferences. You can help with anything — questions, advice, brainstorming, writing, coding, and more. Keep responses under 300 words unless asked for detail.',
    deployedAt: new Date().toISOString(),
    tasksCompleted: 0
  };
  serverAgents.set(guild.id, [generalAgent]);
  addServerKnowledge(guild.id, `Server name: ${guild.name}, Member count: ${guild.memberCount}`);

  let channel = guild.systemChannelId
    ? guild.channels.cache.get(guild.systemChannelId)
    : guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages));

  if (channel) {
    const embed = new EmbedBuilder()
      .setTitle('Montfort is here!')
      .setDescription(
        'Your AI team just landed. Try these right now:\n\n' +
        '**Instant Fun**\n' +
        '• `m!8ball will I be rich?`\n' +
        '• `m!trivia` — test your knowledge\n' +
        '• `m!fact` — learn something wild\n' +
        '• `m!roast @friend` — friendly fire\n' +
        '• `m!poll Pizza or Tacos?`\n\n' +
        '**AI Chat**\n' +
        '• `@Montfort <anything>` — I answer anything\n' +
        '• `m!summarize` — catch up on missed messages\n\n' +
        '**Share me!** `m!invite` to add me to other servers\n\n' +
        '`m!help` for all commands'
      )
      .setColor(C.sage)
      .setFooter({ text: `${BRAND} — I remember conversations. I learn your server over time.` })
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
    const trivia = activeTrivia.get(msg.channel.id);
    if (trivia && !trivia.answerer) {
      const answer = msg.content.trim().toUpperCase();
      if (/^[A-D]$/.test(answer)) {
        const idx = answer.charCodeAt(0) - 65;
        const chosen = trivia.shuffled[idx];
        const correct = chosen === trivia.a;
        trivia.answerer = msg.author.id;
        activeTrivia.delete(msg.channel.id);
        if (correct) {
          await msg.reply({ embeds: [new EmbedBuilder()
            .setTitle('Correct!')
            .setDescription(`The answer is **${trivia.a}**. Well done, <@${msg.author.id}>!`)
            .setColor(C.sage)
          ]});
        } else {
          await msg.reply({ embeds: [new EmbedBuilder()
            .setTitle('Wrong!')
            .setDescription(`You said **${chosen}**, but the answer was **${trivia.a}**. Better luck next time!`)
            .setColor(C.coral)
          ]});
        }
      }
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
        const funLines = Object.entries(COMMANDS_FUN).map(([k, v]) => `**${k}** — ${v}`);
        const agentLines = Object.entries(COMMANDS_AGENTS).map(([k, v]) => `**${k}** — ${v}`);
        const memLines = Object.entries(COMMANDS_MEMORY).map(([k, v]) => `**${k}** — ${v}`);
        const acctLines = Object.entries(COMMANDS_ACCOUNT).map(([k, v]) => `**${k}** — ${v}`);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Montfort Commands')
          .setDescription(
            '**Fun & Games**\n' + funLines.join('\n') +
            '\n\n**AI Agents** (mention @Montfort to talk)\n' + agentLines.join('\n') +
            '\n\n**Memory**\n' + memLines.join('\n') +
            '\n\n**Account & Pro**\n' + acctLines.join('\n')
          )
          .setColor(C.amber)
          .setFooter({ text: `${BRAND} — Fun commands work instantly! Deploy agents for AI chat.` })
        ]});
        return;
      }

      case 'templates': {
        const lines = Object.entries(TEMPLATES).map(([k, v]) => `**${k}** — ${v.name}`);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Agent Templates')
          .setDescription('Deploy with `m!deploy <name>`\n\n' + lines.join('\n'))
          .setColor(C.sage)
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
        .setColor(C.sage)
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
          .setColor(C.amber)
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
          .setColor(C.sage)
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
          .setColor(C.amber)
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
        const text = sanitize(args.join(' '));
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
          .setColor(C.amber)
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

      case '8ball': {
        if (!checkCooldown(userId, '8ball')) { await msg.reply('Slow down! Try again in a moment.'); return; }
        const question = sanitize(args.join(' '));
        if (!question) {
          await msg.reply('Ask a question! `m!8ball will I become famous?`');
          return;
        }
        const answer = FUN.eightball[Math.floor(Math.random() * FUN.eightball.length)];
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Magic 8-Ball')
          .setDescription(`**Q:** ${question}\n\n🎱 **${answer}**`)
          .setColor(C.bg)
        ]});
        return;
      }

      case 'trivia': {
        if (!checkCooldown(userId, 'trivia')) { await msg.reply('Slow down! Try again in a moment.'); return; }
        const existing = activeTrivia.get(channelId);
        if (existing) {
          await msg.reply(`A trivia question is active! Answer it first, or wait for it to expire.\n**Q:** ${existing.q}`);
          return;
        }
        const t = FUN.trivia[Math.floor(Math.random() * FUN.trivia.length)];
        const shuffled = [...t.options].sort(() => Math.random() - 0.5);
        const labels = ['A', 'B', 'C', 'D'];
        const optionText = shuffled.map((o, i) => `${labels[i]}. ${o}`).join('\n');
        activeTrivia.set(channelId, { ...t, shuffled, answerer: null, expires: Date.now() + 30000 });
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Trivia')
          .setDescription(`**${t.q}**\n\n${optionText}\n\nType A, B, C, or D to answer! (30s)`)
          .setColor(C.slate)
        ]});
        setTimeout(() => { activeTrivia.delete(channelId); }, 30000);
        return;
      }

      case 'fact': {
        const fact = FUN.facts[Math.floor(Math.random() * FUN.facts.length)];
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Fun Fact')
          .setDescription(fact)
          .setColor(C.amberLight)
          .setFooter({ text: 'm!fact for another one' })
        ]});
        return;
      }

      case 'roast': {
        if (!checkCooldown(userId, 'roast')) { await msg.reply('Slow down! Try again in a moment.'); return; }
        const target = msg.mentions.users.first();
        const roast = FUN.roasts[Math.floor(Math.random() * FUN.roasts.length)];
        const text = target && target.id !== msg.author.id
          ? `<@${target.id}>, ${roast}`
          : roast;
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Roast')
          .setDescription(text)
          .setColor(C.coral)
          .setFooter({ text: 'All love, no hate' })
        ]});
        return;
      }

      case 'compliment': {
        const target = msg.mentions.users.first();
        const comp = FUN.compliments[Math.floor(Math.random() * FUN.compliments.length)];
        const text = target && target.id !== msg.author.id
          ? `<@${target.id}>, ${comp}`
          : comp;
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Compliment')
          .setDescription(text)
          .setColor(C.sage)
        ]});
        return;
      }

      case 'wyr': {
        const wyr = FUN.wyr[Math.floor(Math.random() * FUN.wyr.length)];
        const pollMsg = await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Would You Rather')
          .setDescription(wyr)
          .setColor(C.lavender)
          .setFooter({ text: 'React with your choice below' })
        ]});
        await pollMsg.react('🅰️');
        await pollMsg.react('🅱️');
        return;
      }

      case 'poll': {
        if (!checkCooldown(userId, 'poll')) { await msg.reply('Slow down! Try again in a moment.'); return; }
        const question = sanitize(args.join(' '));
        if (!question) {
          await msg.reply('Ask something! `m!poll Should we play Valorant?`');
          return;
        }
        const pollMsg = await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Poll')
          .setDescription(`**${question}**`)
          .setColor(C.slate)
          .setFooter({ text: 'React to vote' })
        ]});
        await pollMsg.react('👍');
        await pollMsg.react('👎');
        await pollMsg.react('🤷');
        return;
      }

      case 'define': {
        const word = args[0];
        if (!word) {
          await msg.reply('What word? `m!define serendipity`');
          return;
        }
        await msg.channel.sendTyping();
        const defMessages = [
          { role: 'system', content: 'You are a dictionary. Define the given word concisely. Include: part of speech, definition, and one example sentence. Keep it under 100 words.' },
          { role: 'user', content: `Define: ${word}` }
        ];
        const apiKey = getApiKey(guildId);
        const definition = await callLLM(defMessages, apiKey);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle(`Define: ${word}`)
          .setDescription(definition.slice(0, 4096))
          .setColor(C.amber)
        ]});
        return;
      }

      case 'summarize': {
        const hist = conversationHistory.get(channelId);
        if (!hist || hist.messages.length < 3) {
          await msg.reply('Not enough messages in this channel to summarize yet. Chat more and try again!');
          return;
        }
        await msg.channel.sendTyping();
        const recent = hist.messages.slice(-30);
        const chatLog = recent.map(m => {
          const who = m.role === 'ambient' ? m.content.split(':')[0] : m.role === 'assistant' ? 'Montfort' : 'User';
          const text = m.role === 'ambient' ? m.content.split(':').slice(1).join(':').trim() : m.content;
          return `${who}: ${text}`;
        }).join('\n');
        const sumMessages = [
          { role: 'system', content: 'Summarize the following chat log concisely. Highlight key topics, decisions, and action items. Use bullet points. Keep under 200 words.' },
          { role: 'user', content: chatLog }
        ];
        const apiKey = getApiKey(guildId);
        const summary = await callLLM(sumMessages, apiKey);
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Channel Summary')
          .setDescription(summary.slice(0, 4096))
          .setColor(C.amberLight)
          .setFooter({ text: `${recent.length} messages summarized` })
        ]});
        return;
      }

      case 'remind': {
        const timeStr = args[0];
        const text = sanitize(args.slice(1).join(' '));
        if (!timeStr || !text) {
          await msg.reply('Usage: `m!remind 30m Take pizza out` (supports s/m/h, e.g. 10s, 30m, 2h)');
          return;
        }
        const match = timeStr.match(/^(\d+)(s|m|h)$/);
        if (!match) {
          await msg.reply('Invalid time. Use: `m!remind 30m Do something` (s=seconds, m=minutes, h=hours)');
          return;
        }
        const amount = parseInt(match[1]);
        const unit = match[2];
        let ms = amount * 1000;
        if (unit === 'm') ms = amount * 60 * 1000;
        if (unit === 'h') ms = amount * 60 * 60 * 1000;
        const id = 'remind-' + Date.now();
        const userId = msg.author.id;
        reminders.set(id, { channelId, userId, text, fireAt: Date.now() + ms });
        setTimeout(async () => {
          reminders.delete(id);
          const ch = client.channels.cache.get(channelId);
          if (ch) {
            await ch.send({ embeds: [new EmbedBuilder()
              .setTitle('Reminder')
              .setDescription(`<@${userId}> ⏰ **${text}**`)
              .setColor(C.amber)
            ]});
          }
        }, ms);
        const unitLabel = unit === 's' ? 'second' : unit === 'm' ? 'minute' : 'hour';
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Reminder Set')
          .setDescription(`I'll remind you in ${amount} ${unitLabel}${amount > 1 ? 's' : ''}: **${text}**`)
          .setColor(C.sage)
        ]});
        return;
      }

      case 'invite': {
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Add Montfort to Your Server')
          .setDescription(`Click to invite:\n${INVITE_URL}\n\nWorks instantly — no setup needed. Try m!8ball, m!trivia, m!fact right away!`)
          .setColor(C.sage)
          .setFooter({ text: 'Share this link with friends!' })
        ]});
        return;
      }

      case 'stats': {
        const guilds = client.guilds.cache.size;
        const totalMembers = client.guilds.cache.reduce((sum, g) => sum + g.memberCount, 0);
        let totalTasks = 0;
        let totalAgents = 0;
        let totalFacts = 0;
        for (const [, agents] of serverAgents) {
          totalAgents += agents.length;
          for (const a of agents) totalTasks += a.tasksCompleted;
        }
        for (const [, knowledge] of serverKnowledge) totalFacts += knowledge.length;
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle('Montfort Stats')
          .setDescription(
            `**Servers:** ${guilds}\n` +
            `**Members reached:** ${totalMembers.toLocaleString()}\n` +
            `**Agents deployed:** ${totalAgents}\n` +
            `**Tasks completed:** ${totalTasks}\n` +
            `**Facts remembered:** ${totalFacts}\n\n` +
            `[Add to your server](${INVITE_URL})`
          )
          .setColor(C.slate)
          .setFooter({ text: 'Growing every day' })
        ]});
        return;
      }

      case 'ask': {
        const query = args.join(' ');
        if (!query) {
          await msg.reply('Ask something! `m!ask how do I deploy to AWS?`');
          return;
        }
        const agents = serverAgents.get(guildId) || [];
        if (agents.length === 0) {
          await msg.reply('No agents deployed. Use `m!deploy <template>` first, or just @mention me!');
          return;
        }
        await msg.channel.sendTyping();
        const selectedAgent = pickBestAgent(agents, query) || agents[0];
        pushChannelHistory(channelId, 'user', query, null);
        const messages = buildContextMessages(guildId, channelId, selectedAgent.systemPrompt, query, authorTag, selectedAgent);
        const apiKey = getApiKey(guildId);
        const response = await callLLM(messages, apiKey);
        selectedAgent.tasksCompleted++;
        pushChannelHistory(channelId, 'assistant', response, selectedAgent.name);
        if (apiKey) {
          await apiRequest('/api/v1/dispatch', 'POST', { agentId: selectedAgent.id, prompt: query.slice(0, 2000), source: 'discord' }, apiKey).catch(() => {});
        }
        await msg.reply({ embeds: [new EmbedBuilder()
          .setTitle(`${selectedAgent.name} (auto-routed)`)
          .setDescription(response.slice(0, 4096))
          .setColor(C.amber)
          .setFooter({ text: `${BRAND} • Task #${selectedAgent.tasksCompleted} • Routed via m!ask` })
          .setTimestamp()
        ]});
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
      .setColor(C.sage)
      .setFooter({ text: `${BRAND} • Task #${selectedAgent.tasksCompleted} • I remember this conversation` })
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
