require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');
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
    const wrtc = require('@roamhq/wrtc');
    const { RTCAudioSource, RTCAudioSink } = wrtc.nonstandard;

    const callState = {
      callId, callerName, callerNumber,
      startTime: Date.now(),
      audioBuffer: Buffer.alloc(0),
      silenceInterval: null
    };
    activeCalls.set(callId, callState);

    console.log(`[${callId}] Setting up WebRTC...`);

    const pc = new wrtc.RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    callState.pc = pc;

    const audioSource = new RTCAudioSource();
    callState.audioSource = audioSource;
    const audioTrack = audioSource.createTrack();
    pc.addTrack(audioTrack);

    let audioSink = null;

    pc.ontrack = (event) => {
      console.log(`[${callId}] ontrack: kind=${event.track.kind} enabled=${event.track.enabled} muted=${event.track.muted} readyState=${event.track.readyState}`);
      if (event.track.kind === 'audio') {
        audioSink = new RTCAudioSink(event.track);
        callState.audioSink = audioSink;
        audioSink.ondata = (data) => {
          handleCapturedAudio(callId, data);
        };
        event.track.onunmute = () => console.log(`[${callId}] Remote track unmuted`);
        event.track.onmute = () => console.log(`[${callId}] Remote track muted`);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[${callId}] ICE: ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[${callId}] Connection: ${pc.connectionState}`);
    };

    await pc.setRemoteDescription(new wrtc.RTCSessionDescription({ type: 'offer', sdp: session.sdp }));
    console.log(`[${callId}] Remote description set`);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log(`[${callId}] Local description set`);

    const sdp = await waitForIce(pc, callId);
    const candidateCount = (sdp.match(/a=candidate/g) || []).length;
    console.log(`[${callId}] Answer has ${candidateCount} candidates`);

    const finalSdp = cleanSdp(sdp);
    console.log(`[${callId}] Answer: ${finalSdp.length} bytes`);

    const preOk = await sendAction(callId, 'pre_accept', finalSdp);
    if (!preOk) { cleanupCall(callId); return; }
    console.log(`[${callId}] pre_accept sent, waiting for ICE connected...`);

    await waitForIceConnected(pc, 15000);

    const acceptOk = await sendAction(callId, 'accept', finalSdp);
    console.log(`[${callId}] accept: ${acceptOk ? 'OK' : 'FAILED'}`);
    if (!acceptOk) { cleanupCall(callId); return; }

    callState.silenceInterval = setInterval(() => {
      if (!callState.pc || callState.pc.connectionState === 'closed') {
        clearInterval(callState.silenceInterval);
        return;
      }
      const silence = new Int16Array(480);
      audioSource.onData({
        samples: silence,
        sampleRate: 48000,
        bitsPerSample: 16,
        channelCount: 1
      });
    }, 10);

    console.log(`[${callId}] Call active! Silence streaming started.`);

  } catch (err) {
    console.error(`[${callId}] Call error:`, err.message);
    cleanupCall(callId);
  }
}

function waitForIce(pc, callId, timeout = 8000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve(pc.localDescription.sdp);
      return;
    }
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        resolve(pc.localDescription.sdp);
        return;
      }
    };
    pc.onicegatheringstatechange = check;
    setTimeout(() => {
      console.log(`[${callId}] ICE gathering timeout`);
      resolve(pc.localDescription.sdp);
    }, timeout);
  });
}

function waitForIceConnected(pc, timeout = 15000) {
  return new Promise((resolve) => {
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      resolve();
      return;
    }
    const check = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        pc.removeEventListener('iceconnectionstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('iceconnectionstatechange', check);
    setTimeout(resolve, timeout);
  });
}

function cleanSdp(sdp) {
  let cleaned = sdp;
  cleaned = cleaned.replace(/a=fingerprint:sha-/g, 'a=fingerprint:SHA-');
  cleaned = cleaned.replace(/a=setup:actpass/g, 'a=setup:active');
  if (cleaned.includes('a=inactive')) {
    cleaned = cleaned.replace(/a=inactive/g, 'a=sendrecv');
  }
  cleaned = cleaned.replace(/a=ice-options:trickle\r?\n/g, '');
  const lines = cleaned.split(/\r?\n/).filter(l => {
    if (l.startsWith('a=candidate:') && l.includes('.local')) return false;
    return l.trim().length > 0;
  });
  cleaned = lines.join('\r\n') + '\r\n';
  return cleaned;
}

async function handleCapturedAudio(callId, data) {
  const callState = activeCalls.get(callId);
  if (!callState) return;

  try {
    const { samples, sampleRate } = data;
    if (!samples || samples.length === 0) return;

    let sum = 0;
    let max = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      sum += v;
      if (v > max) max = v;
    }
    const avg = sum / samples.length;

    if (!callState.captureLogged) {
      callState.captureCount = (callState.captureCount || 0) + 1;
      if (callState.captureCount <= 5 || callState.captureCount % 50 === 0) {
        console.log(`[${callId}] Capture #${callState.captureCount} avg=${avg.toFixed(4)} max=${max} len=${samples.length}`);
      }
      if (callState.captureCount === 5) callState.captureLogged = false;
    }

    if (avg < 50) return;

    const int16 = samples instanceof Int16Array ? samples : new Int16Array(samples.length);
    if (!(samples instanceof Int16Array)) {
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
    }

    const binary = Buffer.from(int16.buffer);
    callState.audioBuffer = Buffer.concat([callState.audioBuffer, binary]);

    const rate = sampleRate || 48000;
    const bufferDurationMs = (callState.audioBuffer.length / (rate * 2)) * 1000;

    if (bufferDurationMs >= 1500) {
      const audioToProcess = callState.audioBuffer;
      callState.audioBuffer = Buffer.alloc(0);
      processAudioForAI(callId, audioToProcess, rate);
    }
  } catch (e) {
    console.error(`[${callId}] Capture error:`, e.message);
  }
}

async function processAudioForAI(callId, pcmBuffer, sampleRate) {
  const callState = activeCalls.get(callId);
  if (!callState) return;

  try {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 2);
    const sum = samples.reduce((acc, val) => acc + Math.abs(val), 0);
    const avg = sum / samples.length;
    console.log(`[${callId}] Audio: ${pcmBuffer.length} bytes, ${sampleRate}Hz, avg=${avg.toFixed(1)}`);

    if (avg < 50) {
      console.log(`[${callId}] Audio too quiet, skipping`);
      return;
    }

    let audioToTranscribe = pcmBuffer;
    let audioSampleRate = sampleRate;
    if (sampleRate !== 16000) {
      audioToTranscribe = downsampleBuffer(pcmBuffer, sampleRate, 16000);
      audioSampleRate = 16000;
    }

    const wavBuffer = pcmToWav(audioToTranscribe, audioSampleRate, 1, 16);
    console.log(`[${callId}] Transcribing ${wavBuffer.length} byte WAV...`);
    const text = await transcribeAudio(wavBuffer);
    if (!text || text.trim().length === 0) {
      console.log(`[${callId}] No speech detected`);
      return;
    }

    console.log(`[${callId}] Said: "${text}"`);
    const response = await generateLLMResponse(text);
    console.log(`[${callId}] AI: "${response}"`);

    console.log(`[${callId}] Synthesizing...`);
    const ttsBuffer = await synthesizeSpeech(response);
    if (!ttsBuffer) { console.log(`[${callId}] TTS failed`); return; }

    console.log(`[${callId}] TTS: ${ttsBuffer.length} bytes, playing...`);
    playAudioToCall(callId, ttsBuffer);

  } catch (err) {
    console.error(`[${callId}] AI error:`, err.message);
  }
}

function playAudioToCall(callId, wavBuffer) {
  const callState = activeCalls.get(callId);
  if (!callState || !callState.audioSource) return;

  try {
    if (callState.silenceInterval) {
      clearInterval(callState.silenceInterval);
      callState.silenceInterval = null;
    }
    if (callState.playbackTimeout) {
      clearTimeout(callState.playbackTimeout);
      callState.playbackTimeout = null;
    }

    const headerSize = 44;
    if (wavBuffer.length <= headerSize) { restartSilence(callState); return; }

    const pcmData = wavBuffer.slice(headerSize);
    const srcRate = wavBuffer.readUInt32LE(24) || 44100;
    const targetRate = 48000;

    let playPcm = pcmData;
    if (srcRate !== targetRate) {
      playPcm = upsampleBuffer(pcmData, srcRate, targetRate);
    }

    const frames = [];
    const int16 = new Int16Array(playPcm.buffer, playPcm.byteOffset, playPcm.byteLength / 2);
    const frameSize = 480;
    for (let i = 0; i < int16.length; i += frameSize) {
      const padded = new Int16Array(480);
      const end = Math.min(i + frameSize, int16.length);
      padded.set(int16.slice(i, end));
      frames.push(padded);
    }

    const frameInterval = 10;
    const totalDuration = frames.length * frameInterval;
    let frameIndex = 0;
    const startTime = Date.now();

    const sendFrame = () => {
      if (!callState.pc || callState.pc.connectionState === 'closed') return;

      const elapsed = Date.now() - startTime;
      const expectedFrame = Math.floor(elapsed / frameInterval);

      while (frameIndex < frames.length && frameIndex <= expectedFrame) {
        callState.audioSource.onData({
          samples: frames[frameIndex],
          sampleRate: 48000,
          bitsPerSample: 16,
          channelCount: 1
        });
        frameIndex++;
      }

      if (frameIndex < frames.length) {
        const nextFrameTime = startTime + (frameIndex * frameInterval) - Date.now();
        callState.playbackTimeout = setTimeout(sendFrame, Math.max(1, nextFrameTime));
      } else {
        console.log(`[${callId}] TTS playback complete (${frames.length} frames)`);
        restartSilence(callState);
      }
    };

    sendFrame();

  } catch (err) {
    console.error(`[${callId}] Playback error:`, err.message);
    restartSilence(callState);
  }
}

function restartSilence(callState) {
  if (callState.silenceInterval) clearInterval(callState.silenceInterval);
  callState.silenceInterval = setInterval(() => {
    if (!callState.pc || callState.pc.connectionState === 'closed') {
      clearInterval(callState.silenceInterval);
      return;
    }
    callState.audioSource.onData({
      samples: new Int16Array(480),
      sampleRate: 48000,
      bitsPerSample: 16,
      channelCount: 1
    });
  }, 10);
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

async function sendAction(callId, action, sdp = null) {
  const body = { messaging_product: 'whatsapp', call_id: callId, action };
  if (sdp) body.session = { sdp_type: 'answer', sdp };

  try {
    const response = await axios.post(WHATSAPP_API_URL, body, {
      headers: { Authorization: ACCESS_TOKEN, 'Content-Type': 'application/json' }
    });
    const ok = response.data?.success === true;
    console.log(`[${callId}] ${action}: ${ok ? 'OK' : JSON.stringify(response.data)}`);
    return ok;
  } catch (error) {
    console.error(`[${callId}] ${action}: ${error.response?.data?.error?.message || error.message}`);
    return false;
  }
}

function cleanupCall(callId) {
  const callState = activeCalls.get(callId);
  if (callState) {
    if (callState.silenceInterval) clearInterval(callState.silenceInterval);
    if (callState.playbackTimeout) clearTimeout(callState.playbackTimeout);
    if (callState.audioSink) { try { callState.audioSink.close(); } catch(e) {} }
    if (callState.audioSource) { try { callState.audioSource.close(); } catch(e) {} }
    if (callState.pc) { try { callState.pc.close(); } catch(e) {} }
    activeCalls.delete(callId);
    console.log(`[${callId}] Cleanup done`);
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
