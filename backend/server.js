require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { RTCPeerConnection, RTCSessionDescription, MediaStream } = require('@roamhq/wrtc');
const { RTCAudioSource, RTCAudioSink } = require('@roamhq/wrtc').nonstandard;
const { generateLLMResponse, synthesizeSpeech, transcribeAudio } = require('./ai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);

const WHATSAPP_API_URL = `https://graph.facebook.com/v21.0/${process.env.META_PHONE_NUMBER_ID}/calls`;
const ACCESS_TOKEN = `Bearer ${process.env.META_ACCESS_TOKEN}`;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

const activeCalls = new Map();

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
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    const callState = {
      pc, callId, callerName, callerNumber,
      startTime: Date.now(), audioChunks: [],
      audioBuffer: Buffer.alloc(0), sink: null, source: null
    };
    activeCalls.set(callId, callState);

    let audioTrackAdded = false;

    pc.ontrack = (event) => {
      if (audioTrackAdded) return;
      audioTrackAdded = true;
      console.log('Audio track from WhatsApp');

      const remoteTrack = event.track;
      const sink = new RTCAudioSink(remoteTrack);
      callState.sink = sink;

      let lastTranscript = Date.now();
      let incomingSampleRate = 48000;

      sink.ondata = (data) => {
        incomingSampleRate = data.sampleRate || 48000;
        if (Date.now() - lastTranscript < 3000) return;

        const samples = data.samples;
        if (!samples || samples.length === 0) return;

        const pcmBuffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
        callState.audioBuffer = Buffer.concat([callState.audioBuffer, pcmBuffer]);

        const bytesPerSample = 2;
        const bufferDurationMs = (callState.audioBuffer.length / (incomingSampleRate * bytesPerSample)) * 1000;
        if (bufferDurationMs >= 3000) {
          lastTranscript = Date.now();
          const audioToProcess = callState.audioBuffer;
          callState.audioBuffer = Buffer.alloc(0);
          processAudioForAI(callId, audioToProcess, incomingSampleRate);
        }
      };
    };

    pc.onconnectionstatechange = () => {
      console.log(`State: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') cleanupCall(callId);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`ICE: ${pc.iceConnectionState}`);
    };

    console.log('Setting remote description...');
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: session.sdp }));

    const audioSource = new RTCAudioSource();
    const silenceTrack = audioSource.createTrack();
    pc.addTransceiver(silenceTrack, { direction: 'sendrecv' });
    callState.source = audioSource;

    const sampleRate = 48000;
    const samplesPer10ms = sampleRate / 100;
    const silenceData = { samples: new Int16Array(samplesPer10ms), sampleRate };
    callState.silenceInterval = setInterval(() => {
      try { audioSource.onData(silenceData); } catch (e) {}
    }, 10);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log(`Answer: ${answer.sdp.length} bytes`);

    const preOk = await sendAction(callId, 'pre_accept', answer.sdp);
    if (!preOk) { cleanupCall(callId); return; }

    setTimeout(async () => {
      const acceptOk = await sendAction(callId, 'accept', answer.sdp);
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
  if (!callState?.source) return;

  try {
    const headerSize = 44;
    if (wavBuffer.length <= headerSize) return;

    const pcmData = wavBuffer.slice(headerSize);
    const srcRate = wavBuffer.readUInt32LE(24) || 44100;
    const bitsPerSample = wavBuffer.readUInt16LE(34) || 16;
    const numChannels = wavBuffer.readUInt16LE(22) || 1;
    const targetRate = 48000;

    let playPcm = pcmData;
    let playRate = srcRate;
    if (srcRate !== targetRate) {
      playPcm = upsampleBuffer(pcmData, srcRate, targetRate);
      playRate = targetRate;
      console.log(`Resampled TTS: ${srcRate}Hz -> ${targetRate}Hz`);
    }

    console.log(`Playing: ${playRate}Hz bits=${bitsPerSample} ch=${numChannels} pcm=${playPcm.length} bytes`);

    if (callState.silenceInterval) clearInterval(callState.silenceInterval);

    const samplesPerChunk = Math.floor(playRate / 100) * numChannels;
    const bytesPerSample = bitsPerSample / 8;
    const chunkSize = samplesPerChunk * bytesPerSample;

    let offset = 0;
    const playInterval = setInterval(() => {
      if (offset >= playPcm.length || !activeCalls.has(callId)) {
        clearInterval(playInterval);
        console.log('Playback finished');
        if (activeCalls.has(callId) && callState.source) {
          const sr = 48000;
          const silenceData = { samples: new Int16Array(sr / 100), sampleRate: sr };
          callState.silenceInterval = setInterval(() => {
            try { callState.source.onData(silenceData); } catch (e) {}
          }, 10);
        }
        return;
      }

      const end = Math.min(offset + chunkSize, playPcm.length);
      const chunk = playPcm.slice(offset, end);
      const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);

      try {
        callState.source.onData({ samples, sampleRate: playRate, bitsPerSample, channelCount: numChannels });
      } catch (e) {}

      offset = end;
    }, 10);

    callState.playInterval = playInterval;

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
    try {
      if (callState.silenceInterval) clearInterval(callState.silenceInterval);
      if (callState.playInterval) clearInterval(callState.playInterval);
      callState.sink?.stop();
      callState.source?.close();
      callState.pc?.close();
    } catch (e) {}
    activeCalls.delete(callId);
    console.log(`Cleanup: ${callId}`);
  }
}

app.get('/api/status', (req, res) => {
  res.json({ status: 'running', activeCalls: activeCalls.size });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

server.listen(PORT, () => {
  console.log(`StepTalk Voice Agent on port ${PORT}`);
  console.log(`Webhook: https://steptalk.onrender.com/webhook`);
});
