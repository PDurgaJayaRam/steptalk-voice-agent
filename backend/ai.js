require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');
const { Readable } = require('stream');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'allam-2-7b'; // fastest free: ~219ms TTFT
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_MODEL = 'meta/llama-3.2-11b-vision-instruct';

// ---- Speech normalization (free) — makes TTS sound natural for currency/time ----
function normalizeForSpeech(text) {
  let s = text;
  s = s.replace(/₹\s*/g, 'rupees ');
  s = s.replace(/\bRs\.?\s*/gi, 'rupees ');
  s = s.replace(/\$/g, ' dollars ');
  s = s.replace(/%/g, ' percent ');
  s = s.replace(/&/g, ' and ');
  s = s.replace(/(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)\b/g, (m, h, mm, ap) => `${h} ${mm} ${ap.toUpperCase().split('').join(' ')}`);
  s = s.replace(/\bAM\b/g, 'A M').replace(/\bPM\b/g, 'P M');
  s = s.replace(/(\d{1,2},)?\d{1,3},\d{3}\s*rupees/gi, (m) => {
    const num = parseInt(m.replace(/[,\srupees]/gi, ''), 10);
    if (isNaN(num)) return m;
    return `${numberToIndianWords(num)} rupees`;
  });
  s = s.replace(/(\d),(\d)/g, '$1$2');
  return s;
}

function numberToIndianWords(n) {
  if (n === 0) return 'zero';
  const a = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const b = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  function twoDigits(num) {
    if (num < 20) return a[num];
    return b[Math.floor(num / 10)] + (num % 10 ? ' ' + a[num % 10] : '');
  }
  let res = '';
  const crore = Math.floor(n / 10000000);
  if (crore) { res += twoDigits(crore) + ' crore '; n %= 10000000; }
  const lakh = Math.floor(n / 100000);
  if (lakh) { res += twoDigits(lakh) + ' lakh '; n %= 100000; }
  const thousand = Math.floor(n / 1000);
  if (thousand) { res += twoDigits(thousand) + ' thousand '; n %= 1000; }
  const hundred = Math.floor(n / 100);
  if (hundred) { res += a[hundred] + ' hundred '; n %= 100; }
  if (n) res += twoDigits(n) + ' ';
  return res.trim();
}

// ---- Knowledge base (free, keyword matching, no vector DB) ----
let kbData = [];
try { kbData = require('./knowledge-base.json'); } catch {}
function getRelevantKBForVoice(userInput) {
  const lower = (userInput || '').toLowerCase();
  const relevant = kbData.filter((entry) => entry.keywords.some((k) => lower.includes(k)));
  if (relevant.length === 0) return null;
  return relevant.slice(0, 2).map((e) => e.snippet).join('\n');
}

// ---- Timeout + retry wrapper (free, no deps) ----
async function callWithTimeout(fn, ms = 5000, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err.name === 'AbortError' || err.message.includes('aborted');
      console.log(`[Timeout] attempt ${i + 1}/${retries + 1} ${isAbort ? 'timed out' : err.message}`);
      if (i === retries) throw err;
    }
  }
}

async function transcribeAudio(wavBuffer) {
  try {
    return await callWithTimeout(async (signal) => {
      const formData = new FormData();
      formData.append('file', Readable.from(wavBuffer), { filename: 'audio.wav', contentType: 'audio/wav' });
      formData.append('model', 'whisper-large-v3-turbo');
      formData.append('language', 'en');

      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, ...formData.getHeaders() },
        body: formData,
        signal,
      });

      const data = await response.json();
      if (data.error) {
        console.error('Groq STT error:', JSON.stringify(data.error));
        return '';
      }
      return data.text || '';
    }, 6000, 1);
  } catch (error) {
    console.error('STT Error:', error.message);
    return '';
  }
}

function stripThinking(text) {
  return text.replace(/<\/?think(ing)?>/g, '').trim();
}

// ---- Filler phrases ----
const FILLER_PHRASES = [
  "Let me check that for you, one moment.",
  "Just a second, looking that up.",
  "One moment, let me find that.",
  "Give me a second to check.",
];

function getFillerText() {
  return FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)];
}

// ---- Real-time web search ----
function needsWebSearch(text) {
  const q = text.toLowerCase();
  const livePattern = /\b(weather|temperature|forecast|humidity|price|stock|crypto|bitcoin|ethereum|share|nifty|sensex|news|score|match|game|live|cricket|today|tomorrow|yesterday|breaking|trending|headlines?|update|current|real.?time)\b/;
  if (livePattern.test(q)) return false;
  const factualPatterns = [
    /\b(what is|who is|who was|what was|where is|when is|which is)\b/,
    /\b(define|definition|meaning of|explain|history of|capital of|full form|abbreviation)\b/,
    /\b(how does|how to|why does|why is)\b/,
  ];
  return factualPatterns.some((re) => re.test(q));
}

async function searchDDGInstant(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&no_redirect=1`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'StepTalk/1.0' } });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const parts = [];
    if (data.AbstractText) parts.push(data.AbstractText);
    if (data.Answer) parts.push(data.Answer);
    if (data.Results) {
      for (const r of data.Results.slice(0, 2)) {
        if (r.Text) parts.push(r.Text);
      }
    }
    if (data.RelatedTopics) {
      for (const rt of data.RelatedTopics.slice(0, 2)) {
        if (rt.Text) parts.push(rt.Text);
        if (rt.Topics) {
          for (const t2 of rt.Topics.slice(0, 1)) if (t2.Text) parts.push(t2.Text);
        }
      }
    }
    const text = parts.join('\n').trim();
    return text.length > 20 ? text.slice(0, 1500) : null;
  } catch (e) {
    return null;
  }
}

async function searchWikipedia(query) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'StepTalk/1.0 (contact steptalk)', 'Accept': 'application/json' } });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const hits = data?.query?.search;
    if (!hits || hits.length === 0) return null;
    const top = hits[0];
    const snippet = top.snippet ? top.snippet.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : '';
    try {
      const exUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(top.title)}&format=json&origin=*`;
      const exRes = await fetch(exUrl, { headers: { 'User-Agent': 'StepTalk/1.0' } });
      if (exRes.ok) {
        const exData = await exRes.json();
        const pages = exData?.query?.pages;
        if (pages) {
          const first = Object.values(pages)[0];
          if (first?.extract) return `${top.title}: ${first.extract.slice(0, 800)}\n${snippet}`.slice(0, 1500);
        }
      }
    } catch {}
    return `${top.title}: ${snippet}`.slice(0, 1000);
  } catch (e) {
    return null;
  }
}

async function searchTavily(query) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, search_depth: 'basic', max_results: 3, include_answer: true }),
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const parts = [];
    if (data.answer) parts.push(data.answer);
    if (data.results) {
      for (const r of data.results.slice(0, 3)) {
        if (r.content) parts.push(r.content.slice(0, 500));
      }
    }
    const text = parts.join('\n').trim();
    return text.length > 20 ? text.slice(0, 1800) : null;
  } catch (e) {
    return null;
  }
}

async function searchBrave(query) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': key },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const results = data?.web?.results || [];
    const parts = results.slice(0, 3).map((r) => `${r.title}: ${r.description || ''}`).join('\n');
    return parts.length > 20 ? parts.slice(0, 1800) : null;
  } catch (e) {
    return null;
  }
}

async function webSearch(query) {
  const start = Date.now();
  if (process.env.TAVILY_API_KEY) {
    const r = await searchTavily(query);
    if (r) {
      console.log(`[Search] Tavily OK (${Date.now() - start}ms) ${r.length} chars`);
      return r;
    }
  }
  if (process.env.BRAVE_API_KEY) {
    const r = await searchBrave(query);
    if (r) {
      console.log(`[Search] Brave OK (${Date.now() - start}ms) ${r.length} chars`);
      return r;
    }
  }
  const [ddg, wiki] = await Promise.all([searchDDGInstant(query), searchWikipedia(query)]);
  const combined = [ddg, wiki].filter(Boolean).join('\n\n');
  if (combined) {
    console.log(`[Search] Free (DDG+Wiki) OK (${Date.now() - start}ms) ${combined.length} chars`);
    return combined.slice(0, 2000);
  }
  console.log(`[Search] No results (${Date.now() - start}ms)`);
  return null;
}

// ---- Production voice agent prompt (7-layer architecture) ----
// Based on: Vapi, Retell, Bland, Deepgram, ElevenLabs best practices
const LAUNCH_CRAFT_VOICE_BASE =
  // Layer 1: Identity & Disclosure
  `You are an AI voice assistant for Launch Craft Agency on a WhatsApp voice call. ` +
  `You help potential clients learn about our services and schedule meetings with the team. ` +
  `Never claim to be human. If asked, say "I'm an AI assistant for Launch Craft."` +

  // Layer 2: Speaking Style (CRITICAL for TTS)
  `\n\nSPEAKING RULES (strict):` +
  `\n- Maximum 2 sentences per response, under 25 words total.` +
  `\n- Always end with a question to signal the caller's turn.` +
  `\n- Never use markdown, bullet points, numbers as digits, brackets, or emojis.` +
  `\n- Read prices as words: "twenty thousand rupees" not "₹20,000".` +
  `\n- Read phone numbers as groups: "nine one eight seven nine zero four zero six five one six".` +
  `\n- Never say "Great!", "Absolutely!", "Of course!" — they sound scripted.` +
  `\n- Use natural pauses with commas, not periods mid-sentence.` +
  `\n- If interrupted mid-sentence, STOP immediately. Do not finish your thought.` +

  // Layer 3: Scope & Services
  `\n\nSERVICES (answer only from this list):` +
  `\n- Website development (business sites, e-commerce, landing pages)` +
  `\n- App development (Android, iOS, cross-platform)` +
  `\n- Digital marketing (Meta Ads, YouTube Ads, Google Ads, SEO)` +
  `\n- AI automation (chatbots, voice agents, workflow automation)` +
  `\n- Brand marketing (social media, content strategy, brand identity)` +

  // Layer 4: Grounding & Refusal
  `\n\nKNOWLEDGE RULES:` +
  `\n- Answer ONLY from the services list above and any provided context.` +
  `\n- If you don't know something, say: "I'm not sure about that, but our team can help."` +
  `\n- Never invent prices, timelines, or capabilities not provided.` +
  `\n- For pricing questions: "Pricing depends on your requirements — would you like to discuss with our team?"` +

  // Layer 5: Conversation Flow
  `\n\nCONVERSATION GOAL:` +
  `\n1. Greet warmly, identify the agency.` +
  `\n2. Understand what service they need (one question at a time).` +
  `\n3. Briefly confirm understanding.` +
  `\n4. Offer to connect with the team or schedule a meeting.` +
  `\n5. If they want a meeting: ask their name, then best time to call.` +
  `\n6. If they want a human: say "I'll have our team reach out to you shortly."` +

  // Layer 6: Escalation Triggers
  `\n\nESCALATION (say this exactly):` +
  `\n- "Would you like me to connect you with our team?" — when they show interest.` +
  `\n- "Let me have our team call you back." — when they ask for a human.` +
  `\n- "I'll note that down for our team." — when you can't answer.` +

  // Layer 7: Tone
  `\n\nTONE: Warm, professional, like a helpful colleague. Not robotic, not overly casual. ` +
  `Speak naturally with short, clear sentences.`;

function buildMessages(userInput, searchContext, proactiveMeeting) {
  const kbSnippet = getRelevantKBForVoice(userInput);
  const kbPrefix = kbSnippet ? `\nRELEVANT INFO: ${kbSnippet}\n` : '';
  const proactiveSuffix = proactiveMeeting
    ? `\n\nCONVERSION CUE: The caller is interested. After answering, ask: "Would you like me to connect you with our team?"`
    : '';
  const systemPrompt = searchContext
    ? `${LAUNCH_CRAFT_VOICE_BASE}${kbPrefix}\nLIVE CONTEXT: ${searchContext.slice(0, 800)}${proactiveSuffix}`
    : `${LAUNCH_CRAFT_VOICE_BASE}${kbPrefix}${proactiveSuffix}`;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userInput }
  ];
}

// ---- LLM: Groq primary (219ms TTFT) -> NVIDIA fallback (708ms TTFT) ----
async function generateLLMResponse(userInput, searchContext = null, proactiveMeeting = false) {
  const messages = buildMessages(userInput, searchContext, proactiveMeeting);

  // Try Groq first (fastest free)
  try {
    const data = await callWithTimeout(async (signal) => {
      const response = await fetch(GROQ_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({ model: GROQ_MODEL, messages, stream: false, max_tokens: 60, temperature: 0.3 }),
        signal,
      });
      const j = await response.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j;
    }, 8000, 1);

    if (data.choices && data.choices.length > 0) {
      let content = data.choices[0].message.content || '';
      content = stripThinking(content);
      if (content.length > 0) {
        console.log(`[LLM] Groq ${GROQ_MODEL} OK`);
        return content;
      }
    }
  } catch (error) {
    console.error(`[LLM] Groq error, falling back to NVIDIA:`, error.message);
  }

  // Fallback to NVIDIA
  try {
    const data = await callWithTimeout(async (signal) => {
      const response = await fetch(NVIDIA_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${NVIDIA_API_KEY}` },
        body: JSON.stringify({ model: NVIDIA_MODEL, messages, stream: false, max_tokens: 60, temperature: 0.3 }),
        signal,
      });
      const j = await response.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j;
    }, 10000, 1);

    if (data.choices && data.choices.length > 0) {
      let content = data.choices[0].message.content || '';
      content = stripThinking(content);
      if (content.length > 0) {
        console.log(`[LLM] NVIDIA ${NVIDIA_MODEL} OK (fallback)`);
        return content;
      }
    }
    throw new Error('No response from LLM');
  } catch (error) {
    console.error('LLM Error:', error.message);
    return "I'm sorry, I didn't catch that. Could you please repeat?";
  }
}

async function* generateLLMResponseStream(userInput, searchContext = null, proactiveMeeting = false) {
  const messages = buildMessages(userInput, searchContext, proactiveMeeting);

  // Try Groq first (fastest free)
  try {
    const response = await callWithTimeout(async (signal) => {
      return await fetch(GROQ_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
        body: JSON.stringify({ model: GROQ_MODEL, messages, stream: true, max_tokens: 60, temperature: 0.3 }),
        signal,
      });
    }, 10000, 1);

    if (response.ok) {
      console.log(`[LLM] Streaming from Groq ${GROQ_MODEL}`);
      const reader = response.body;
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let thinkBuffer = '';
      let inThink = false;

      for await (const chunk of reader) {
        sseBuffer += decoder.decode(chunk, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') return;
            try {
              const parsed = JSON.parse(data);
              const token = parsed.choices?.[0]?.delta?.content;
              if (!token) continue;
              if (token.includes('<think')) inThink = true;
              if (inThink) {
                thinkBuffer += token;
                if (thinkBuffer.includes('</think>')) {
                  inThink = false;
                  thinkBuffer = '';
                }
                continue;
              }
              yield token;
            } catch (e) {}
          }
        }
      }
      return;
    } else {
      const errText = await response.text();
      console.error(`[LLM] Groq error ${response.status}: ${errText}, falling back to NVIDIA`);
    }
  } catch (error) {
    console.error(`[LLM] Groq stream error, falling back to NVIDIA:`, error.message);
  }

  // Fallback to NVIDIA
  try {
    const response = await callWithTimeout(async (signal) => {
      return await fetch(NVIDIA_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${NVIDIA_API_KEY}` },
        body: JSON.stringify({ model: NVIDIA_MODEL, messages, stream: true, max_tokens: 60, temperature: 0.3 }),
        signal,
      });
    }, 10000, 1);

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[LLM] NVIDIA NIM error ${response.status}: ${errText}`);
      yield "Sorry, I encountered an error. Could you repeat that?";
      return;
    }

    console.log(`[LLM] Streaming from NVIDIA ${NVIDIA_MODEL} (fallback)`);
    const reader = response.body;
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let thinkBuffer = '';
    let inThink = false;

    for await (const chunk of reader) {
      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data);
            const token = parsed.choices?.[0]?.delta?.content;
            if (!token) continue;
            if (token.includes('<think')) inThink = true;
            if (inThink) {
              thinkBuffer += token;
              if (thinkBuffer.includes('</think>')) {
                inThink = false;
                thinkBuffer = '';
              }
              continue;
            }
            yield token;
          } catch (e) {}
        }
      }
    }
  } catch (error) {
    console.error('LLM Stream Error:', error.message);
    yield "Sorry, I encountered an error. Could you repeat that?";
  }
}

async function synthesizeSpeech(text) {
  const normalized = normalizeForSpeech(text);
  if (normalized !== text) console.log(`[TTS] Normalized: "${text.slice(0,60)}..." -> "${normalized.slice(0,60)}..."`);
  try {
    return await callWithTimeout(async (signal) => {
      const voiceId = process.env.FISH_VOICE_ID;
      console.log(`[TTS] Fish Audio: voice=${voiceId} text="${normalized.substring(0, 60)}..."`);

      const response = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.FISH_API_KEY}`,
          'model': 's2.1-pro-free'
        },
        body: JSON.stringify({
          text: normalized,
          reference_id: voiceId,
          format: 'wav',
          sample_rate: 44100,
          latency: 'normal',
          temperature: 0.0,
          top_p: 1.0,
          normalize: true,
          prosody: { speed: 1.1, volume: 0, normalize_loudness: true }
        }),
        signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[TTS] Fish Audio error ${response.status}: ${errText}`);
        throw new Error(`Fish Audio API error: ${response.status}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      console.log(`[TTS] Fish Audio OK: ${buffer.length} bytes`);
      return buffer;
    }, 10000, 1);
  } catch (error) {
    console.error('[TTS] Error:', error.message);
    return null;
  }
}

module.exports = { generateLLMResponse, generateLLMResponseStream, synthesizeSpeech, transcribeAudio, webSearch, needsWebSearch, getFillerText };
