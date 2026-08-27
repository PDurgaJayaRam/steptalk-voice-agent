require('dotenv').config();
const FormData = require('form-data');
const { Readable } = require('stream');
const fs = require('fs');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const GROQ_API_KEY = process.env.GROQ_API_KEY;

function pcmToWav(pcmData, sampleRate, numChannels, bitsPerSample) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, 44);
  return buffer;
}

async function testGroqSTT() {
  const sampleRate = 16000;
  const duration = 3;
  const numSamples = sampleRate * duration;
  const pcmData = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = 440;
    const sample = Math.floor(16000 * Math.sin(2 * Math.PI * freq * t));
    pcmData.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }

  const wavBuffer = pcmToWav(pcmData, sampleRate, 1, 16);
  console.log(`Test WAV: ${wavBuffer.length} bytes, ${sampleRate}Hz`);

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
    console.log('Response:', JSON.stringify(data, null, 2));
    if (data.error) {
      console.log('ERROR:', data.error.message);
    } else {
      console.log('Text:', data.text);
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testGroqSTT();
