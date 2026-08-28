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
    formData.append('model', 'whisper-large-v3');
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
      content: 'You are StepTalk AI, a professional sales assistant. Respond DIRECTLY to the customer in 1-2 short sentences. Never show your thinking process. Never use bullet points or numbered lists. Just speak naturally like a friendly human assistant would on a phone call.'
    },
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
        model: 'nvidia/nemotron-3-nano-30b-a3b',
        messages,
        stream: false,
        max_tokens: 256,
        temperature: 0.3
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

async function synthesizeSpeech(text) {
  try {
    const voiceId = process.env.FISH_VOICE_ID;
    console.log(`[TTS] Fish Audio: voice=${voiceId} text="${text.substring(0, 80)}..."`);

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
        prosody: { speed: 1, volume: 0, normalize_loudness: true },
        repetition_penalty: 1.0,
        condition_on_previous_chunks: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[TTS] Fish Audio error ${response.status}: ${errText}`);
      throw new Error(`Fish Audio API error: ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    const buffer = Buffer.from(await response.arrayBuffer());
    console.log(`[TTS] Fish Audio OK: ${buffer.length} bytes, content-type=${contentType}`);
    return buffer;
  } catch (error) {
    console.error('[TTS] Error:', error.message);
    return null;
  }
}

module.exports = { generateLLMResponse, synthesizeSpeech, transcribeAudio };
