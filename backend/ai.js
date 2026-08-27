require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');
const { Readable } = require('stream');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

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
      content: 'You are StepTalk AI, a professional sales assistant. Keep responses concise, friendly, and under 2-3 sentences. You help customers with product inquiries and guide them through purchases.'
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
        model: 'openai/gpt-oss-20b',
        messages,
        stream: false,
        max_tokens: 200
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('Groq LLM error:', JSON.stringify(data.error));
      throw new Error(data.error.message);
    }

    if (data.choices && data.choices.length > 0) {
      return data.choices[0].message.content;
    }

    throw new Error('No response from Groq LLM');
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
        'Authorization': `Bearer ${process.env.FISH_API_KEY}`,
        'model': 's2.1-pro-free'
      },
      body: JSON.stringify({
        text,
        reference_id: process.env.FISH_VOICE_ID,
        format: 'wav'
      })
    });

    if (!response.ok) {
      throw new Error(`Fish Audio API error: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer;
  } catch (error) {
    console.error('TTS Error:', error.message);
    return null;
  }
}

module.exports = { generateLLMResponse, synthesizeSpeech, transcribeAudio };
