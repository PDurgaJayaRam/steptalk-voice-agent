require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');
const { Readable } = require('stream');

const FISH_API_KEY = process.env.FISH_API_KEY;
const FISH_VOICE_ID = process.env.FISH_VOICE_ID;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_ENDPOINT = process.env.NVIDIA_ENDPOINT || 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

async function transcribeAudio(audioBuffer) {
  try {
    const formData = new FormData();
    formData.append('file', Readable.from(audioBuffer), { filename: 'audio.wav', contentType: 'audio/wav' });
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
      console.error('Groq error:', JSON.stringify(data.error));
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
      content: 'You are StepTalk AI, a professional sales assistant. Keep responses concise, friendly, and under 2-3 sentences. You help customers with product inquiries and guide them through purchases.'
    },
    { role: 'user', content: userInput }
  ];

  try {
    const response = await fetch(NVIDIA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NVIDIA_API_KEY}`
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages,
        stream: false,
        max_tokens: 200
      })
    });

    const data = await response.json();

    if (data.choices && data.choices.length > 0) {
      return data.choices[0].message.content;
    }

    throw new Error('No response from NVIDIA NIM');
  } catch (error) {
    console.error('LLM Error:', error.message);
    return "I'm sorry, I didn't catch that. Could you please repeat?";
  }
}

async function synthesizeSpeech(text) {
  try {
    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FISH_API_KEY}`
      },
      body: JSON.stringify({
        text,
        reference_id: FISH_VOICE_ID,
        format: 'wav'
      })
    });

    if (!response.ok) {
      throw new Error(`Fish Audio API error: ${response.status}`);
    }

    const buffer = await response.buffer();
    return buffer;
  } catch (error) {
    console.error('TTS Error:', error.message);
    return null;
  }
}

module.exports = { generateLLMResponse, synthesizeSpeech, transcribeAudio };
