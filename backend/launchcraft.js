const { generateLLMResponse } = require('./ai');
const { saveLead, notifyOwner } = require('./leads');

const SERVICES = [
  'Web Development',
  'App Development',
  'Brand Marketing (Meta Ads, YouTube, Instagram Handling, Google Ads)',
  'AI Automation',
  'Voice Agents (like me - automated calling & customer handling)',
];

const SERVICE_KEYWORDS = {
  web: 'Web Development',
  website: 'Web Development',
  app: 'App Development',
  application: 'App Development',
  marketing: 'Brand Marketing (Meta Ads, YouTube, Instagram, Google Ads)',
  meta: 'Brand Marketing (Meta Ads, YouTube, Instagram, Google Ads)',
  ads: 'Brand Marketing (Meta Ads, YouTube, Instagram, Google Ads)',
  instagram: 'Brand Marketing (Meta Ads, YouTube, Instagram, Google Ads)',
  youtube: 'Brand Marketing (Meta Ads, YouTube, Instagram, Google Ads)',
  google: 'Brand Marketing (Meta Ads, YouTube, Instagram, Google Ads)',
  ai: 'AI Automation',
  automation: 'AI Automation',
  voice: 'Voice Agents',
  bot: 'Voice Agents',
  agent: 'Voice Agents',
};

// Chat state per user wa_id
const chatStates = new Map(); // wa_id -> { step, data }

const LAUNCH_CRAFT_VOICE_PROMPT =
  `You are Launch Craft Agency's voice bot on a WhatsApp call. ` +
  `Welcome the caller warmly to Launch Craft. ` +
  `We offer: 1) Web Development, 2) App Development, 3) Brand Marketing (Meta Ads, YouTube, Instagram Handling, Google Ads), 4) AI Automation, 5) Voice Agents like you (automated calling & customer handling). ` +
  `Be helpful, warm, and concise. Answer in ONE short sentence, 10 words max, ALWAYS end with punctuation. ` +
  `If they ask to schedule a meeting, say you will connect them to the Launch Craft Team shortly and ask for their name and preferred time. ` +
  `If they want to speak to a human, say the team will call them back within a few minutes. ` +
  `Never use lists, markdown, or bullet points. This is a voice call, so be conversational.`;

const LAUNCH_CRAFT_CHAT_PROMPT =
  `You are Launch Craft, a WhatsApp business assistant for Launch Craft Agency. ` +
  `We offer: Web Development, App Development, Brand Marketing (Meta Ads, YouTube, Instagram Handling, Google Ads), AI Automation, and Voice Agents (like you - automated calling & customer handling bots). ` +
  `Be friendly, concise, and helpful. Guide the client to the right service. ` +
  `If they want a meeting, collect name, service, and preferred time. ` +
  `Keep replies short (2-3 sentences max). Use simple formatting, no markdown headings.`;

function getVoiceSystemPrompt(searchContext) {
  if (searchContext) {
    return `${LAUNCH_CRAFT_VOICE_PROMPT}\nLive info: ${searchContext.slice(0, 1200)}`;
  }
  return LAUNCH_CRAFT_VOICE_PROMPT;
}

function detectService(text) {
  const lower = text.toLowerCase();
  for (const [kw, svc] of Object.entries(SERVICE_KEYWORDS)) {
    if (lower.includes(kw)) return svc;
  }
  return null;
}

function isMeetingIntent(text) {
  const lower = text.toLowerCase();
  return /meeting|schedule|book|appointment|call me|talk to|human|team|connect|contact/.test(lower);
}

function isGreeting(text) {
  return /^(hi|hello|hey|hii|good morning|good evening|namaste)/i.test(text.trim());
}

// Main chat handler — called from server.js webhook for incoming text messages
async function handleChatMessage({ from, text, profileName, sendMessage }) {
  const waId = from;
  const trimmed = (text || '').trim();
  if (!trimmed) return;

  let state = chatStates.get(waId);

  // If user is in meeting collection flow, continue that
  if (state && state.step) {
    await handleMeetingFlow(waId, trimmed, state, sendMessage, profileName);
    return;
  }

  // Check for meeting intent to start flow
  if (isMeetingIntent(trimmed) && !/^(hi|hello)/i.test(trimmed)) {
    // User directly asks for meeting
    const svc = detectService(trimmed);
    chatStates.set(waId, { step: 'ask_name', data: { service: svc || '', waId, profileName, message: trimmed } });
    await sendMessage(waId, `Great! I can schedule a call with the Launch Craft Team for you. 🙌\n\nMay I know your name please?`);
    return;
  }

  // Greeting — welcome + services
  if (isGreeting(trimmed)) {
    await sendMessage(
      waId,
      `Hello ${profileName || ''}! 👋 Welcome to *Launch Craft Agency*.\n\n` +
        `We help businesses grow with:\n` +
        `• Web Development\n` +
        `• App Development\n` +
        `• Brand Marketing (Meta Ads, YouTube, Instagram, Google Ads)\n` +
        `• AI Automation\n` +
        `• Voice Agents (like me 🤖)\n\n` +
        `What are you looking for today? Just tell me — e.g. "I need a website" or "help with Instagram marketing".`
    );
    return;
  }

  // Detect service mention -> guide + offer meeting
  const svc = detectService(trimmed);
  if (svc) {
    await sendMessage(
      waId,
      `Got it — *${svc}* is one of our core services at Launch Craft. ✅\n\n` +
        `We can build exactly what you need. Would you like to schedule a quick call with our team to discuss it? Just say "schedule a meeting" or tell me your preferred time.`
    );
    return;
  }

  // Fallback: use LLM for open-ended questions about Launch Craft
  try {
    const llmText = await generateLLMResponse(
      `Client said: "${trimmed}". ${LAUNCH_CRAFT_CHAT_PROMPT} Reply helpfully and end by asking if they want to schedule a call with the team.`,
      null
    );
    let reply = llmText || `I can help you with Web Development, App Development, Brand Marketing, AI Automation, or Voice Agents. What do you need?`;
    // Ensure meeting CTA
    if (!/meeting|call|schedule/i.test(reply)) {
      reply += ` Want me to schedule a call with the Launch Craft Team?`;
    }
    await sendMessage(waId, reply);
  } catch (e) {
    console.error('[LaunchCraft] LLM fallback error:', e.message);
    await sendMessage(
      waId,
      `Thanks for reaching out to Launch Craft! We offer Web Development, App Development, Brand Marketing, AI Automation, and Voice Agents. What service are you interested in?`
    );
  }
}

async function handleMeetingFlow(waId, text, state, sendMessage, profileName) {
  const data = state.data;

  switch (state.step) {
    case 'ask_name': {
      data.name = text.slice(0, 80);
      if (!data.service) {
        state.step = 'ask_service';
        await sendMessage(waId, `Thanks, ${data.name}! Which service are you interested in?\n\n1️⃣ Web Development\n2️⃣ App Development\n3️⃣ Brand Marketing\n4️⃣ AI Automation\n5️⃣ Voice Agents\n\nJust reply with the number or name.`);
      } else {
        state.step = 'ask_time';
        await sendMessage(waId, `Thanks, ${data.name}! When would you prefer the team to call you? (e.g. "tomorrow 11am" or "today evening")`);
      }
      break;
    }
    case 'ask_service': {
      // Accept number or text
      const numMap = { '1': SERVICES[0], '2': SERVICES[1], '3': SERVICES[2], '4': SERVICES[3], '5': SERVICES[4] };
      const svc = numMap[text.trim()] || detectService(text) || text.slice(0, 100);
      data.service = svc;
      state.step = 'ask_time';
      await sendMessage(waId, `Great — *${svc}* it is! When should the Launch Craft Team call you? (e.g. "tomorrow 4pm")`);
      break;
    }
    case 'ask_time': {
      data.preferredTime = text.slice(0, 100);
      data.phone = waId;
      data.profileName = profileName;

      // Save lead
      const lead = saveLead({
        name: data.name,
        phone: waId,
        waId,
        service: data.service,
        preferredTime: data.preferredTime,
        message: data.message,
        profileName,
        source: 'whatsapp_chat',
      });

      // Notify owner (fire and forget)
      notifyOwner(lead).catch(() => {});

      chatStates.delete(waId);
      await sendMessage(
        waId,
        `✅ Done, ${data.name}! Your meeting for *${data.service}* is scheduled.\n\n` +
          `Preferred time: *${data.preferredTime}*\n` +
          `The Launch Craft Team will reach out to you within a few minutes on this number.\n\n` +
          `If you need to speak urgently, just reply "call me". Thank you for choosing Launch Craft! 🚀`
      );
      break;
    }
    default:
      chatStates.delete(waId);
      await sendMessage(waId, `How can I help you with Launch Craft services today?`);
      break;
  }
}

module.exports = {
  handleChatMessage,
  getVoiceSystemPrompt,
  LAUNCH_CRAFT_VOICE_PROMPT,
  LAUNCH_CRAFT_CHAT_PROMPT,
  SERVICES,
  chatStates,
  isMeetingIntent,
  detectService,
};
