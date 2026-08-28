require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const FormData = require('form-data');
const { Readable } = require('stream');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const GROQ_LLM_MODEL = 'llama-3.3-70b-versatile';

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
        model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        messages,
        stream: false,
        max_tokens: 512,
        temperature: 0.3
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('NVIDIA LLM error:', JSON.stringify(data.error));
      throw new Error(data.error.message);
    }

    if (data.choices && data.choices.length > 0) {
      let content = data.choices[0].message.content || '';
      const quotedMatch = content.match(/"([^"]{5,})"\s*$/);
      if (quotedMatch) return quotedMatch[1].trim();

      const lines = content.split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
        const line = lines[i].replace(/^["']|["']$/g, '').trim();
        if (line.length > 5
          && !line.startsWith('**')
          && !line.match(/^\d[\.\)]/)
          && !line.startsWith('-')
          && !line.includes('StepTalk')
          && !line.includes('system')
          && !line.includes('thinking')
          && !line.includes('Analyze')
          && !line.includes('Response')
          && !line.includes('Directly')
          && !line.includes('Draft')
          && !line.includes('Check')
          && !line.includes('Constraints')
          && !line.includes('Identify')
          && !line.includes('Determine')) {
          return line;
        }
      }
      return content.slice(-100).trim();
    }

    throw new Error('No response from NVIDIA NIM');
  } catch (error) {
    console.error('NVIDIA LLM failed, trying Groq:', error.message);
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: GROQ_LLM_MODEL,
          messages,
          max_tokens: 256,
          temperature: 0.3
        })
      });
      const groqData = await groqRes.json();
      if (groqData.choices && groqData.choices.length > 0) {
        return groqData.choices[0].message.content.trim();
      }
    } catch (groqErr) {
      console.error('Groq LLM Error:', groqErr.message);
    }
    return "I'm sorry, I'm having trouble connecting. Could you please repeat?";
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
