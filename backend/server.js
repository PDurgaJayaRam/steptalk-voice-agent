require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const axios = require('axios');
const WebSocket = require('ws');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { generateLLMResponse, synthesizeSpeech, transcribeAudio } = require('./ai');

function findChrome() {
  const searchPaths = [
    path.join(__dirname, 'chromium'),
    process.env.PUPPETEER_CACHE_DIR,
    '/opt/render/.cache/puppeteer'
  ].filter(Boolean);

  for (const baseDir of searchPaths) {
    try {
      const chromeDir = path.join(baseDir, 'chrome');
      if (!fs.existsSync(chromeDir)) continue;
      const versions = fs.readdirSync(chromeDir);
      for (const ver of versions) {
        for (const sub of ['chrome-linux64', 'chrome-win64']) {
          for (const bin of ['chrome', 'chrome.exe']) {
            const p = path.join(chromeDir, ver, sub, bin);
            if (fs.existsSync(p)) { console.log(`Found Chrome: ${p}`); return p; }
          }
        }
      }
    } catch (e) {}
  }
  console.log('Chrome not found in any search path');
  return null;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);

const WHATSAPP_API_URL = `https://graph.facebook.com/v21.0/${process.env.META_PHONE_NUMBER_ID}/calls`;
const ACCESS_TOKEN = `Bearer ${process.env.META_ACCESS_TOKEN}`;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

const activeCalls = new Map();

const wss = new WebSocket.Server({ server, path: '/bridge' });
let bridgeWs = null;
let browser = null;
let bridgePage = null;
let pendingAnswerResolve = null;

wss.on('connection', (ws) => {
  console.log('Bridge connected');
  bridgeWs = ws;

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ready') {
        console.log('Bridge page ready');
      } else if (msg.type === 'answer') {
        console.log(`Bridge answer: ${msg.sdp.length} bytes`);
        if (pendingAnswerResolve) {
          pendingAnswerResolve(msg.sdp);
          pendingAnswerResolve = null;
        }
      } else if (msg.type === 'captured') {
        handleCapturedAudio(msg);
      } else if (msg.type === 'ice') {
        console.log(`Bridge ICE: ${msg.state}`);
      } else if (msg.type === 'connection') {
        console.log(`Bridge connection: ${msg.state}`);
      } else if (msg.type === 'playback_done') {
        console.log('Bridge playback done');
      } else if (msg.type === 'error') {
        console.error('Bridge error:', msg.error);
      }
    } catch (e) {
      console.error('Bridge message error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('Bridge disconnected');
    if (bridgeWs === ws) bridgeWs = null;
  });
});

async function handleCapturedAudio(msg) {
  const callState = activeCalls.get(msg.callId);
  if (!callState) return;

  try {
    const pcmBase64 = msg.pcm;
    const binary = Buffer.from(pcmBase64, 'base64');
    const samples = new Int16Array(binary.buffer, binary.byteOffset, binary.byteLength / 2);
    const sum = samples.reduce((acc, val) => acc + Math.abs(val), 0);
    const avg = sum / samples.length;

    if (avg < 50) return;

    callState.audioBuffer = Buffer.concat([callState.audioBuffer, binary]);

    const sampleRate = msg.sampleRate || 48000;
    const bytesPerSample = 2;
    const bufferDurationMs = (callState.audioBuffer.length / (sampleRate * bytesPerSample)) * 1000;

    if (bufferDurationMs >= 3000) {
      const audioToProcess = callState.audioBuffer;
      callState.audioBuffer = Buffer.alloc(0);
      processAudioForAI(msg.callId, audioToProcess, sampleRate);
    }
  } catch (e) {
    console.error('Captured audio error:', e.message);
  }
}

async function launchBridge() {
  if (browser && bridgePage && bridgeWs) return;

  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error('Chrome not found. Ensure @puppeteer/browsers install ran during build.');
  }

  console.log(`Launching Puppeteer with ${chromePath}...`);
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--autoplay-policy=no-user-gesture-required'
    ]
  });

  bridgePage = await browser.newPage();
  bridgePage.on('console', msg => console.log('BRIDGE:', msg.text()));
  bridgePage.on('pageerror', err => console.error('BRIDGE ERROR:', err.message));

  await bridgePage.goto(`http://127.0.0.1:${PORT}/bridge`, { waitUntil: 'networkidle0', timeout: 15000 });
  console.log('Bridge page loaded');

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (bridgeWs) { clearInterval(check); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(check); resolve(); }, 10000);
  });
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const call = change?.value?.calls?.[0];
    const contact = change?.value?.contacts?.[0];

    if (!call || !call.id || !call.event) return res.sendStatus(200);

    const callId = call.id;
    console.log(`[${call.event}] ${callId}`);

    if (call.event === 'connect') {
      const callerName = contact?.profile?.name || 'Unknown';
      const callerNumber = contact?.wa_id || 'Unknown';
      const session = call.session;
      console.log(`Call from ${callerName} (${callerNumber})`);
      await handleIncomingCall(callId, session, callerName, callerNumber);
    } else if (call.event === 'terminate') {
      console.log(`Terminated | duration=${call.duration || '?'}s status=${call.status || '?'}`);
      if (call.errors) console.log(`Errors:`, JSON.stringify(call.errors));
      cleanupCall(callId);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(200);
  }
});

async function handleIncomingCall(callId, session, callerName, callerNumber) {
  if (!session?.sdp) return;

  try {
    await launchBridge();

    const callState = {
      callId, callerName, callerNumber,
      startTime: Date.now(),
      audioBuffer: Buffer.alloc(0)
    };
    activeCalls.set(callId, callState);

    console.log('Sending offer to bridge...');
    const answerPromise = new Promise((resolve, reject) => {
      pendingAnswerResolve = resolve;
      setTimeout(() => { if (pendingAnswerResolve) { pendingAnswerResolve = null; reject(new Error('Bridge timeout')); } }, 10000);
    });

    bridgeWs.send(JSON.stringify({ type: 'offer', sdp: session.sdp, callId }));

    const answerSdp = await answerPromise;

    let finalSdp = answerSdp.replace(/a=setup:actpass/g, 'a=setup:active');
    if (finalSdp.includes('a=inactive')) {
      finalSdp = finalSdp.replace(/a=inactive/g, 'a=sendrecv');
    }
    console.log(`Answer: ${finalSdp.length} bytes`);

    const preOk = await sendAction(callId, 'pre_accept', finalSdp);
    if (!preOk) { cleanupCall(callId); return; }

    setTimeout(async () => {
      const acceptOk = await sendAction(callId, 'accept', finalSdp);
      console.log(acceptOk ? 'Call active! Speak now...' : 'Accept failed');
      if (!acceptOk) cleanupCall(callId);
    }, 2000);

  } catch (err) {
    console.error('Call error:', err.message);
    cleanupCall(callId);
  }
}

async function processAudioForAI(callId, pcmBuffer, sampleRate) {
  const callState = activeCalls.get(callId);
  if (!callState) return;

  try {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 2);
    const sum = samples.reduce((acc, val) => acc + Math.abs(val), 0);
    const avg = sum / samples.length;
    console.log(`Audio: ${pcmBuffer.length} bytes, ${sampleRate}Hz, avg amplitude=${avg.toFixed(1)}`);

    if (avg < 50) {
      console.log('Audio too quiet, skipping');
      return;
    }

    let audioToTranscribe = pcmBuffer;
    let audioSampleRate = sampleRate;
    if (sampleRate !== 16000) {
      audioToTranscribe = downsampleBuffer(pcmBuffer, sampleRate, 16000);
      audioSampleRate = 16000;
      console.log(`Downsampled: ${pcmBuffer.length} -> ${audioToTranscribe.length} bytes (48k->16k)`);
    }

    const wavBuffer = pcmToWav(audioToTranscribe, audioSampleRate, 1, 16);

    console.log(`Transcribing ${wavBuffer.length} byte WAV...`);
    const text = await transcribeAudio(wavBuffer);
    if (!text || text.trim().length === 0) {
      console.log('No speech detected');
      return;
    }

    console.log(`Said: "${text}"`);
    const response = await generateLLMResponse(text);
    console.log(`AI: "${response}"`);

    console.log('Synthesizing...');
    const ttsBuffer = await synthesizeSpeech(response);
    if (!ttsBuffer) { console.log('TTS failed'); return; }

    console.log(`TTS: ${ttsBuffer.length} bytes, playing to caller...`);
    playAudioToCall(callId, ttsBuffer);

  } catch (err) {
    console.error('AI error:', err.message);
  }
}

function playAudioToCall(callId, wavBuffer) {
  const callState = activeCalls.get(callId);
  if (!callState || !bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) return;

  try {
    const headerSize = 44;
    if (wavBuffer.length <= headerSize) return;

    const pcmData = wavBuffer.slice(headerSize);
    const srcRate = wavBuffer.readUInt32LE(24) || 44100;
    const numChannels = wavBuffer.readUInt16LE(22) || 1;
    const targetRate = 48000;

    let playPcm = pcmData;
    if (srcRate !== targetRate) {
      playPcm = upsampleBuffer(pcmData, srcRate, targetRate);
      console.log(`Resampled TTS: ${srcRate}Hz -> ${targetRate}Hz`);
    }

    console.log(`Playing: ${targetRate}Hz pcm=${playPcm.length} bytes`);
    const pcmBase64 = playPcm.toString('base64');
    bridgeWs.send(JSON.stringify({
      type: 'audio',
      pcm: pcmBase64,
      sampleRate: targetRate,
      channels: numChannels,
      callId
    }));

  } catch (err) {
    console.error('Playback error:', err.message);
  }
}

function upsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  const ratio = outputSampleRate / inputSampleRate;
  const newLength = Math.round(buffer.length / 2 * ratio);
  const result = Buffer.alloc(newLength * 2);
  const inputView = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
  const outputView = new Int16Array(result.buffer, result.byteOffset, newLength);

  for (let i = 0; i < newLength; i++) {
    const srcPos = i / ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = inputView[idx] || 0;
    const b = inputView[idx + 1] || 0;
    outputView[i] = Math.round(a + (b - a) * frac);
  }
  return result;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = Buffer.alloc(newLength * 2);
  const inputView = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
  const outputView = new Int16Array(result.buffer, result.byteOffset, newLength);

  for (let i = 0; i < newLength; i++) {
    const pos = Math.round(i * ratio);
    outputView[i] = inputView[pos] || 0;
  }
  return result;
}

function pcmToWav(pcmData, sampleRate, numChannels, bitsPerSample) {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

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
  pcmData.copy(buffer, headerSize);

  return buffer;
}

async function sendAction(callId, action, sdp = null) {
  const body = { messaging_product: 'whatsapp', call_id: callId, action };
  if (sdp) body.session = { sdp_type: 'answer', sdp };

  try {
    const response = await axios.post(WHATSAPP_API_URL, body, {
      headers: { Authorization: ACCESS_TOKEN, 'Content-Type': 'application/json' }
    });
    const ok = response.data?.success === true;
    console.log(`${action}: ${ok ? 'OK' : JSON.stringify(response.data)}`);
    return ok;
  } catch (error) {
    console.error(`${action}: ${error.response?.data?.error?.message || error.message}`);
    return false;
  }
}

function cleanupCall(callId) {
  const callState = activeCalls.get(callId);
  if (callState) {
    if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
      bridgeWs.send(JSON.stringify({ type: 'stop', callId }));
    }
    activeCalls.delete(callId);
    console.log(`Cleanup: ${callId}`);
  }
}

app.get('/bridge', (req, res) => {
  res.sendFile(path.join(__dirname, 'bridge.html'));
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'running', activeCalls: activeCalls.size, bridge: !!bridgeWs });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

server.listen(PORT, async () => {
  console.log(`StepTalk Voice Agent on port ${PORT}`);
  console.log(`Webhook: https://steptalk.onrender.com/webhook`);
  try {
    await launchBridge();
  } catch (e) {
    console.error('Bridge launch failed (will retry on call):', e.message);
  }
});
