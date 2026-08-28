require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { generateLLMResponse, generateLLMResponseStream, synthesizeSpeech, transcribeAudio } = require('./ai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);

const WHATSAPP_API_URL = `https://graph.facebook.com/v21.0/${process.env.META_PHONE_NUMBER_ID}/calls`;
const ACCESS_TOKEN = `Bearer ${process.env.META_ACCESS_TOKEN}`;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

const activeCalls = new Map();

const VAD = {
  SPEECH_THRESHOLD: 80,
  SILENCE_THRESHOLD: 30,
  MIN_SPEECH_FRAMES: 15,
  SILENCE_AFTER_SPEECH_FRAMES: 30,
  BARGE_IN_THRESHOLD: 200,
};

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
      silenceInterval: null,
      playbackTimeout: null,
      isPlaying: false,
      isProcessing: false,
      vadState: 'IDLE',
      vadSpeechFrames: 0,
      vadSilenceFrames: 0,
      captureCount: 0,
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

    pc.ontrack = (event) => {
      if (event.track.kind === 'audio') {
        const audioSink = new RTCAudioSink(event.track);
        callState.audioSink = audioSink;
        audioSink.ondata = (data) => {
          handleCapturedAudio(callId, data);
        };
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

    startSilenceStreaming(callState);

    console.log(`[${callId}] Call active! Full-duplex VAD enabled.`);

  } catch (err) {
    console.error(`[${callId}] Call error:`, err.message);
    cleanupCall(callId);
  }
}

function startSilenceStreaming(callState) {
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

function computeFrameEnergy(samples) {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    sum += v;
    if (v > max) max = v;
  }
  return { avg: sum / samples.length, max };
}

async function handleCapturedAudio(callId, data) {
  const callState = activeCalls.get(callId);
  if (!callState) return;

  try {
    const { samples, sampleRate } = data;
    if (!samples || samples.length === 0) return;

    const { avg, max } = computeFrameEnergy(samples);

    callState.captureCount++;

    if (callState.isPlaying && avg >= VAD.BARGE_IN_THRESHOLD) {
      console.log(`[${callId}] BARGE-IN detected (avg=${avg.toFixed(0)}) — stopping playback`);
      stopPlayback(callState);
      callState.audioBuffer = Buffer.alloc(0);
      callState.vadState = 'SPEAKING';
      callState.vadSpeechFrames = 1;
      callState.vadSilenceFrames = 0;
      const binary = Buffer.from(samples instanceof Int16Array ? samples.buffer : new Int16Array(samples).buffer);
      callState.audioBuffer = Buffer.concat([callState.audioBuffer, binary]);
      return;
    }

    if (callState.isPlaying || callState.isProcessing) return;

    switch (callState.vadState) {
      case 'IDLE':
        if (avg >= VAD.SPEECH_THRESHOLD) {
          callState.vadSpeechFrames++;
          if (callState.vadSpeechFrames >= VAD.MIN_SPEECH_FRAMES) {
            callState.vadState = 'SPEAKING';
            callState.audioBuffer = Buffer.alloc(0);
            const binary = Buffer.from(samples instanceof Int16Array ? samples.buffer : new Int16Array(samples).buffer);
            callState.audioBuffer = Buffer.concat([callState.audioBuffer, binary]);
          }
        } else {
          callState.vadSpeechFrames = 0;
        }
        break;

      case 'SPEAKING':
        const binarySpeak = Buffer.from(samples instanceof Int16Array ? samples.buffer : new Int16Array(samples).buffer);
        callState.audioBuffer = Buffer.concat([callState.audioBuffer, binarySpeak]);

        if (avg < VAD.SILENCE_THRESHOLD) {
          callState.vadSilenceFrames++;
          if (callState.vadSilenceFrames >= VAD.SILENCE_AFTER_SPEECH_FRAMES) {
            callState.vadState = 'IDLE';
            callState.vadSpeechFrames = 0;
            callState.vadSilenceFrames = 0;

            const audioToProcess = callState.audioBuffer;
            callState.audioBuffer = Buffer.alloc(0);

            if (audioToProcess.length > 0) {
              callState.isProcessing = true;
              processAudioForAI(callId, audioToProcess, sampleRate || 48000);
            }
          }
        } else {
          callState.vadSilenceFrames = 0;
        }
        break;
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
    const durationMs = (pcmBuffer.length / (sampleRate * 2)) * 1000;
    console.log(`[${callId}] Audio: ${pcmBuffer.length} bytes, ${sampleRate}Hz, avg=${avg.toFixed(1)}, dur=${durationMs.toFixed(0)}ms`);

    if (avg < 30 || durationMs < 200) {
      console.log(`[${callId}] Audio too quiet/short, skipping`);
      callState.isProcessing = false;
      return;
    }

    let audioToTranscribe = pcmBuffer;
    let audioSampleRate = sampleRate;
    if (sampleRate !== 16000) {
      audioToTranscribe = downsampleBuffer(pcmBuffer, sampleRate, 16000);
      audioSampleRate = 16000;
    }

    const wavBuffer = pcmToWav(audioToTranscribe, audioSampleRate, 1, 16);
    const sttStart = Date.now();
    const text = await transcribeAudio(wavBuffer);
    const sttMs = Date.now() - sttStart;
    console.log(`[${callId}] STT (${sttMs}ms): "${text}"`);

    if (!text || text.trim().length === 0) {
      console.log(`[${callId}] No speech detected`);
      callState.isProcessing = false;
      return;
    }

    const llmStart = Date.now();
    let sentenceBuffer = '';
    let sentenceCount = 0;

    for await (const token of generateLLMResponseStream(text)) {
      if (!callState.pc || callState.pc.connectionState === 'closed') {
        console.log(`[${callId}] LLM streaming interrupted (connection closed)`);
        break;
      }

      sentenceBuffer += token;

      const sentenceEnd = sentenceBuffer.match(/[.!?]+[\s"']*/);
      if (sentenceEnd) {
        const sentenceEndIndex = sentenceBuffer.indexOf(sentenceEnd[0]) + sentenceEnd[0].length;
        const sentence = sentenceBuffer.slice(0, sentenceEndIndex).trim();
        sentenceBuffer = sentenceBuffer.slice(sentenceEndIndex);

        if (sentence.length > 5) {
          sentenceCount++;
          const ttsStart = Date.now();
          const ttsBuffer = await synthesizeSpeech(sentence);
          const ttsMs = Date.now() - ttsStart;

          if (ttsBuffer) {
            console.log(`[${callId}] Sentence ${sentenceCount} TTS (${ttsMs}ms): ${ttsBuffer.length} bytes`);
            playAudioToCall(callId, ttsBuffer);
          }
        }
      }
    }

    if (sentenceBuffer.trim().length > 5) {
      sentenceCount++;
      const ttsStart = Date.now();
      const ttsBuffer = await synthesizeSpeech(sentenceBuffer.trim());
      const ttsMs = Date.now() - ttsStart;

      if (ttsBuffer) {
        console.log(`[${callId}] Sentence ${sentenceCount} TTS (${ttsMs}ms): ${ttsBuffer.length} bytes`);
        playAudioToCall(callId, ttsBuffer);
      }
    }

    const llmMs = Date.now() - llmStart;
    console.log(`[${callId}] LLM stream complete (${llmMs}ms, ${sentenceCount} sentences)`);

    callState.isProcessing = false;

  } catch (err) {
    console.error(`[${callId}] AI error:`, err.message);
    callState.isProcessing = false;
  }
}

function stopPlayback(callState) {
  if (callState.playbackTimeout) {
    clearTimeout(callState.playbackTimeout);
    callState.playbackTimeout = null;
  }
  callState.isPlaying = false;
}

function playAudioToCall(callId, wavBuffer) {
  const callState = activeCalls.get(callId);
  if (!callState || !callState.audioSource) return;

  try {
    stopPlayback(callState);
    if (callState.silenceInterval) {
      clearInterval(callState.silenceInterval);
      callState.silenceInterval = null;
    }

    const headerSize = 44;
    if (wavBuffer.length <= headerSize) {
      console.log(`[${callId}] WAV too small: ${wavBuffer.length} bytes`);
      startSilenceStreaming(callState);
      return;
    }

    const riff = wavBuffer.toString('ascii', 0, 4);
    const wave = wavBuffer.toString('ascii', 8, 12);
    const fmt = wavBuffer.toString('ascii', 12, 16);
    const audioFormat = wavBuffer.readUInt16LE(20);
    const numChannels = wavBuffer.readUInt16LE(22);
    const srcRate = wavBuffer.readUInt32LE(24) || 44100;
    const bitsPerSample = wavBuffer.readUInt16LE(34);
    const dataSize = wavBuffer.readUInt32LE(40);
    console.log(`[${callId}] WAV: riff=${riff} wave=${wave} fmt=${fmt} format=${audioFormat} ch=${numChannels} rate=${srcRate} bits=${bitsPerSample} dataSize=${dataSize} total=${wavBuffer.length}`);

    const pcmData = wavBuffer.slice(headerSize);
    const targetRate = 48000;

    let playPcm = pcmData;
    if (srcRate !== targetRate) {
      playPcm = upsampleBuffer(pcmData, srcRate, targetRate);
    }

    const int16 = new Int16Array(playPcm.buffer, playPcm.byteOffset, playPcm.byteLength / 2);
    let pcmMax = 0, pcmMin = 0, pcmSum = 0;
    for (let i = 0; i < int16.length; i++) {
      const v = int16[i];
      pcmSum += Math.abs(v);
      if (v > pcmMax) pcmMax = v;
      if (v < pcmMin) pcmMin = v;
    }
    const pcmAvg = pcmSum / int16.length;
    console.log(`[${callId}] PCM: ${int16.length} samples (${(int16.length/48000).toFixed(2)}s) max=${pcmMax} min=${pcmMin} avg=${pcmAvg.toFixed(1)}`);

    if (pcmMax === 0) {
      console.log(`[${callId}] WARNING: PCM data is SILENT (all zeros)`);
      startSilenceStreaming(callState);
      return;
    }

    const frames = [];
    const frameSize = 480;
    for (let i = 0; i < int16.length; i += frameSize) {
      const padded = new Int16Array(480);
      const end = Math.min(i + frameSize, int16.length);
      padded.set(int16.slice(i, end));
      frames.push(padded);
    }

    console.log(`[${callId}] Playback: ${frames.length} frames, ${(frames.length * 10 / 1000).toFixed(1)}s`);

    callState.isPlaying = true;
    const frameInterval = 10;
    let frameIndex = 0;
    const startTime = Date.now();

    const sendFrame = () => {
      if (!callState.pc || callState.pc.connectionState === 'closed' || !callState.isPlaying) {
        callState.isPlaying = false;
        return;
      }

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
        console.log(`[${callId}] Playback complete (${frames.length} frames)`);
        callState.isPlaying = false;
        startSilenceStreaming(callState);
      }
    };

    sendFrame();

  } catch (err) {
    console.error(`[${callId}] Playback error:`, err.message);
    callState.isPlaying = false;
    startSilenceStreaming(callState);
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
