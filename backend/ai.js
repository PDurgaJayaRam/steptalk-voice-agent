require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');
const { Readable } = require('stream');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

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

async function generateLLMResponse(userInput) {
  const messages = [
    {
      role: 'system',
      content: 'You are StepTalk AI, a professional and friendly voice assistant. Respond in 1 short sentence maximum, under 15 words. ALWAYS end your response with a period, exclamation mark, or question mark. Speak naturally like a human on a phone call. Never use bullet points, lists, markdown, or thinking tags. Be concise, warm, and helpful.'
    },
    { role: 'user', content: userInput }
  ];

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages,
        stream: false,
        max_tokens: 100,
        temperature: 0.5
      })
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message);
    }

    if (data.choices && data.choices.length > 0) {
      let content = data.choices[0].message.content || '';
      content = content.replace(/<think>[\s\S]*?<\/thought>/g, '').trim();
      if (content.length > 0) return content;
    }

    throw new Error('No response from LLM');
  } catch (error) {
    console.error('LLM Error:', error.message);
    return "I'm sorry, I didn't catch that. Could you please repeat?";
  }
}

async function* generateLLMResponseStream(userInput) {
  const messages = [
    {
      role: 'system',
      content: 'You are StepTalk AI, a professional and friendly voice assistant. Respond in 1 short sentence maximum, under 15 words. ALWAYS end your response with a period, exclamation mark, or question mark. Speak naturally like a human on a phone call. Never use bullet points, lists, markdown, or thinking tags. Be concise, warm, and helpful.'
    },
    { role: 'user', content: userInput }
  ];

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages,
        stream: true,
        max_tokens: 100,
        temperature: 0.5
      })
    });

    const reader = response.body;
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of reader) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          try {
            const parsed = JSON.parse(data);
            const token = parsed.choices?.[0]?.delta?.content;
            if (token) yield token;
          } catch (e) {}
        }
      }
    }
  } catch (error) {
    console.error('LLM Stream Error:', error.message);
    yield "I'm sorry, I didn't catch that. Could you please repeat?";
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

module.exports = { generateLLMResponse, generateLLMResponseStream, synthesizeSpeech, transcribeAudio };
