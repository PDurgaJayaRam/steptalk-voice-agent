require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');
const { Readable } = require('stream');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

async function transcribeAudio(wavBuffer) {
  try {
    const formData = new FormData();
    formData.append('file', Readable.from(wavBuffer), { filename: 'audio.wav', contentType: 'audio/wav' });
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'en');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    const data = await response.json();
    if (data.error) {
      console.error('Groq STT error:', JSON.stringify(data.error));
      return '';
    }
    return data.text || '';
  } catch (error) {
    console.error('STT Error:', error.message);
    return '';
  }
}

function stripThinking(text) {
  return text.replace(/<\/?think(ing)?>/g, '').trim();
}

// ---- Filler phrases: spoken while waiting for slow LLM/search so caller doesn't think call died ----
const FILLER_PHRASES = [
  "Let me check that for you, one moment.",
  "Just a second, looking that up.",
  "One moment, let me find that.",
  "Give me a second to check.",
];

function getFillerText() {
  return FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)];
}

// ---- Real-time web search: FREE, no API key required (DDG Instant + Wikipedia) ----
// Narrowed (Fix 4): only fire for factual queries DDG/Wiki can answer (definitions, general facts).
// Live queries (price/news/score/weather) are skipped — free tier returns empty/generic and wastes 0.8-1.5s.
// Those live cases fall through to LLM which says "I don't have live data" per system prompt.
// Optional upgrade: set TAVILY_API_KEY or BRAVE_API_KEY for true live web search; then broaden this.
function needsWebSearch(text) {
  const q = text.toLowerCase();
  // Block live queries that free tier can't answer reliably
  const livePattern = /\b(weather|temperature|forecast|humidity|price|stock|crypto|bitcoin|ethereum|share|nifty|sensex|news|score|match|game|live|cricket|today|tomorrow|yesterday|breaking|trending|headlines?|update|current|real.?time)\b/;
  if (livePattern.test(q)) return false;

  // Only factual definitional queries where DDG Instant / Wikipedia shine
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
    // Fetch snippet + fetch first page extract for top hit
    const top = hits[0];
    const snippet = top.snippet ? top.snippet.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : '';
    // Try to get extract
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
  // Priority: Tavily / Brave (best live) -> free fallback (DDG + Wikipedia in parallel)
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
  // Free tier: DDG Instant + Wikipedia in parallel
  const [ddg, wiki] = await Promise.all([searchDDGInstant(query), searchWikipedia(query)]);
  const combined = [ddg, wiki].filter(Boolean).join('\n\n');
  if (combined) {
    console.log(`[Search] Free (DDG+Wiki) OK (${Date.now() - start}ms) ${combined.length} chars`);
    return combined.slice(0, 2000);
  }
  console.log(`[Search] No results (${Date.now() - start}ms)`);
  return null;
}

const LAUNCH_CRAFT_VOICE_BASE =
  `You are Launch Craft Agency's voice bot on a WhatsApp call. Welcome the caller warmly to Launch Craft. ` +
  `We offer: Web Development, App Development, Brand Marketing (Meta Ads, YouTube, Instagram Handling, Google Ads), AI Automation, and Voice Agents like you. ` +
  `Be helpful, warm, and concise. Answer in ONE short sentence, 10 words max, ALWAYS end with punctuation. ` +
  `If they ask to schedule a meeting, say you will connect them to the Launch Craft Team shortly and ask for their name and preferred time. ` +
  `If they want to speak to a human, say the team will call them back within a few minutes. ` +
  `Never use lists, markdown, or bullet points. This is a voice call, so be conversational.`;

async function generateLLMResponse(userInput, searchContext = null) {
  const systemPrompt = searchContext
    ? `${LAUNCH_CRAFT_VOICE_BASE}\nLive info: ${searchContext.slice(0, 1200)}\nAnswer in ONE short sentence, 10 words max. ALWAYS end with punctuation. Be natural and warm.`
    : LAUNCH_CRAFT_VOICE_BASE + ` Answer in ONE short sentence, 10 words max, ALWAYS end with punctuation (period, exclamation, or question mark).`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userInput }
  ];

  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NVIDIA_API_KEY}`
      },
      body: JSON.stringify({
        model: 'meta/llama-3.2-11b-vision-instruct',
        messages,
        stream: false,
        max_tokens: 100,
        temperature: 0.5
      })
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || JSON.stringify(data.error));
    }

    if (data.choices && data.choices.length > 0) {
      let content = data.choices[0].message.content || '';
      content = stripThinking(content);
      if (content.length > 0) return content;
    }

    throw new Error('No response from LLM');
  } catch (error) {
    console.error('LLM Error:', error.message);
    return "I'm sorry, I didn't catch that. Could you please repeat?";
  }
}

async function* generateLLMResponseStream(userInput, searchContext = null) {
  const systemPrompt = searchContext
    ? `${LAUNCH_CRAFT_VOICE_BASE}\nLive info: ${searchContext.slice(0, 1200)}\nAnswer in ONE short sentence, 10 words max, ALWAYS end with punctuation. Be natural and warm. If info is missing, say you could not find live data.`
    : LAUNCH_CRAFT_VOICE_BASE + ` Answer in ONE short sentence, 10 words max, ALWAYS end with punctuation (period, exclamation, or question mark).`;
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userInput }
  ];

  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NVIDIA_API_KEY}`
      },
      body: JSON.stringify({
        model: 'meta/llama-3.2-11b-vision-instruct',
        messages,
        stream: true,
        max_tokens: 100,
        temperature: 0.5
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[LLM] NVIDIA NIM error ${response.status}: ${errText}`);
      yield "Sorry, I encountered an error. Could you repeat that?";
      return;
    }

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
  try {
    const voiceId = process.env.FISH_VOICE_ID;
    console.log(`[TTS] Fish Audio: voice=${voiceId} text="${text.substring(0, 60)}..."`);

    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.FISH_API_KEY}`,
        'model': 's2.1-pro-free'
      },
      body: JSON.stringify({
        text,
        reference_id: voiceId,
        format: 'wav',
        sample_rate: 44100,
        latency: 'normal',
        temperature: 0.0,
        top_p: 1.0,
        normalize: true,
        prosody: { speed: 1.1, volume: 0, normalize_loudness: true }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TTS] Fish Audio error ${response.status}: ${errText}`);
      throw new Error(`Fish Audio API error: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(`[TTS] Fish Audio OK: ${buffer.length} bytes`);
    return buffer;
  } catch (error) {
    console.error('[TTS] Error:', error.message);
    return null;
  }
}

module.exports = { generateLLMResponse, generateLLMResponseStream, synthesizeSpeech, transcribeAudio, webSearch, needsWebSearch, getFillerText };

