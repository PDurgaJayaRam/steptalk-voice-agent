require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { generateLLMResponse, generateLLMResponseStream, synthesizeSpeech, transcribeAudio, webSearch, needsWebSearch, getFillerText } = require('./ai');

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
  MIN_SPEECH_FRAMES: 20,
  SILENCE_AFTER_SPEECH_FRAMES: 70,
  BARGE_IN_THRESHOLD: 200,
};

// Per-call latency instrumentation (Fix 3) — keyed by callId, logged per utterance
const callTimings = new Map(); // callId -> { t0, t2 } for VAD; per-utterance timings logged in processAudioForAI
function logLatency(callId, timings) {
  const d = (a, b) => (a && b ? `${b - a}ms` : '-');
  console.log(
    `[LATENCY] ${callId} vad_detect=${d(timings.t0, timings.t2)} stt=${d(timings.t3, timings.t4)} ` +
      `llm_ttft=${d(timings.t5, timings.t6)} tts=${d(timings.t7, timings.t8)} total=${d(timings.t0, timings.t8)} ` +
      `| t0=${timings.t0 || '-'} t2=${timings.t2 || '-'} t3=${timings.t3 || '-'} t4=${timings.t4 || '-'} t5=${timings.t5 || '-'} t6=${timings.t6 || '-'} t7=${timings.t7 || '-'} t8=${timings.t8 || '-'}`
  );
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
    const value = change?.value;

    // ---- WhatsApp Chat Messages (Launch Craft) - ADDITIVE, does not affect calls ----
    const messages = value?.messages;
    const statuses = value?.statuses;
    if (messages && messages.length > 0) {
      // Handle chat messages async but respond 200 immediately to avoid retry
      handleWhatsAppMessages(value).catch((e) => console.error('[Chat] handler error:', e.message));
      // If there is also a call in same payload, continue to call handling below
      // otherwise respond
      if (!value?.calls?.[0]) {
        res.sendStatus(200);
        return;
      }
    }
    if (statuses && !value?.calls?.[0] && !messages) {
      // Status updates (delivered/read) - just ack
      res.sendStatus(200);
      return;
    }

    // ---- WhatsApp Calls (existing, untouched) ----
    const call = value?.calls?.[0];
    const contact = value?.contacts?.[0];

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

// ---- Launch Craft Chat Handlers (additive) ----
const { handleChatMessage, isMeetingIntent: isVoiceMeetingIntent, detectService: detectVoiceService } = require('./launchcraft');
const { getLeads, saveLead: saveVoiceLead, notifyOwner: notifyVoiceOwner, logCallOutcome: logVoiceOutcome, enrichLead: enrichVoiceLead, getCallOutcomes } = require('./leads');

async function sendWhatsAppText(to, body) {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!phoneId || !token) {
    console.error('[Chat] META credentials missing');
    return false;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${phoneId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[Chat] Sent to ${to}: ${body.slice(0, 80)}...`);
    return true;
  } catch (err) {
    console.error(`[Chat] Send failed to ${to}: ${err.response?.data?.error?.message || err.message}`);
    return false;
  }
}

async function handleWhatsAppMessages(value) {
  const messages = value.messages || [];
  const contacts = value.contacts || [];
  for (const msg of messages) {
    const from = msg.from;
    const profileName = contacts.find((c) => c.wa_id === from)?.profile?.name || '';
    // Only handle text for now; ignore other types gracefully
    let text = '';
    if (msg.type === 'text') text = msg.text?.body || '';
    else if (msg.type === 'button') text = msg.button?.text || '';
    else if (msg.type === 'interactive') text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
    else {
      console.log(`[Chat] Ignoring non-text type: ${msg.type} from ${from}`);
      continue;
    }
    if (!text) continue;
    console.log(`[Chat] ${from} (${profileName}): ${text.slice(0, 100)}`);
    await handleChatMessage({ from, text, profileName, sendMessage: sendWhatsAppText });
  }
}

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
      leadCaptured: false,
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

    // Proactive Launch Craft welcome greeting - caller hears intro immediately without needing to speak first
    const greeting = `Hello! Welcome to Launch Craft Agency. We help businesses grow with Web Development, App Development, Brand Marketing including Meta Ads, YouTube, Instagram handling and Google Ads, AI Automation, and Voice Agents like me. How can I help you today?`;
    synthesizeSpeech(greeting).then((greetingBuf) => {
      if (greetingBuf && activeCalls.has(callId)) {
        console.log(`[${callId}] Playing welcome greeting (${greetingBuf.length} bytes)`);
        playAudioToCall(callId, greetingBuf);
      }
    }).catch((e) => console.error(`[${callId}] Greeting TTS error:`, e.message));

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
      if (callState.processingTimeout) {
        clearTimeout(callState.processingTimeout);
        callState.processingTimeout = null;
      }
      callState.isProcessing = false;
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
            // T0 — first speech frame crosses threshold
            const t = callTimings.get(callId) || {};
            t.t0 = Date.now();
            callTimings.set(callId, t);
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
              // T2 — utterance finalized (silence-after triggers)
              const t2 = callTimings.get(callId) || {};
              t2.t2 = Date.now();
              callTimings.set(callId, t2);
              callState.isProcessing = true;
              callState.processingTimeout = setTimeout(() => {
                if (callState.isProcessing) {
                  console.log(`[${callId}] WARNING: isProcessing stuck for 15s, resetting`);
                  callState.isProcessing = false;
                }
              }, 15000);
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

  let fillerTimer = null;
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
    // T3/T4 — STT
    const timings = callTimings.get(callId) || {};
    timings.t3 = Date.now();
    const sttStart = Date.now();
    const text = await transcribeAudio(wavBuffer);
    const sttMs = Date.now() - sttStart;
    timings.t4 = Date.now();
    callTimings.set(callId, timings);
    console.log(`[${callId}] STT (${sttMs}ms): "${text}"`);

    if (!text || text.trim().length === 0) {
      console.log(`[${callId}] No speech detected`);
      callState.isProcessing = false;
      if (callTimings.has(callId)) { logLatency(callId, callTimings.get(callId)); callTimings.delete(callId); }
      return;
    }

    // ---- Launch Craft Voice Lead Flow (collect details, notify owner) ----

    // If already in voice lead collection, continue flow
    if (callState.voiceLead && callState.voiceLead.step) {
      const step = callState.voiceLead.step;
      const data = callState.voiceLead.data;
      if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
      // Step handlers
      if (step === 'ask_name') {
        const name = text.trim().slice(0, 60).replace(/my name is/i, '').trim() || data.callerName || 'there';
        data.name = name;
        console.log(`[${callId}] Voice lead: name=${name}`);
        if (data.detectedService) {
          data.service = data.detectedService;
          callState.voiceLead.step = 'ask_time';
          const askTime = `Thanks ${name}! When should the Launch Craft Team call you? You can say tomorrow morning, tonight, or any time that works for you.`;
          const buf = await synthesizeSpeech(askTime);
          if (buf) playAudioToCall(callId, buf);
          // Also send WhatsApp text fallback to caller
          if (data.callerNumber && data.callerNumber !== 'Unknown') {
            sendWhatsAppText(data.callerNumber, `Hi ${name}! When should we call you? Reply with preferred time.`).catch(()=>{});
          }
        } else {
          callState.voiceLead.step = 'ask_service';
          const askSvc = `Thanks ${name}! Which service are you interested in? We offer Web Development, App Development, Brand Marketing, AI Automation, or Voice Agents.`;
          const buf = await synthesizeSpeech(askSvc);
          if (buf) playAudioToCall(callId, buf);
        }
        if (callState.processingTimeout) { clearTimeout(callState.processingTimeout); callState.processingTimeout = null; }
        callState.isProcessing = false;
        // latency for voice lead ask_name (no LLM) - log stt + cleanup
        if (callTimings.has(callId)) { logLatency(callId, callTimings.get(callId)); callTimings.delete(callId); }
        return;
      }
      if (step === 'ask_service') {
        const svc = detectVoiceService(text) || text.trim().slice(0, 80);
        data.service = svc;
        console.log(`[${callId}] Voice lead: service=${svc}`);
        callState.voiceLead.step = 'ask_time';
        const askTime = `Great, ${svc} it is! When should the team call you back? You can say tomorrow eleven A M, or this evening.`;
        const buf = await synthesizeSpeech(askTime);
        if (buf) playAudioToCall(callId, buf);
        if (callState.processingTimeout) { clearTimeout(callState.processingTimeout); callState.processingTimeout = null; }
        callState.isProcessing = false;
        if (callTimings.has(callId)) { logLatency(callId, callTimings.get(callId)); callTimings.delete(callId); }
        return;
      }
      if (step === 'ask_time') {
        const time = text.trim().slice(0, 100);
        data.preferredTime = time;
        data.phone = data.callerNumber;
        data.waId = data.callerNumber;
        console.log(`[${callId}] Voice lead: time=${time} -> saving`);
        let lead = await saveVoiceLead({
          name: data.name,
          phone: data.callerNumber,
          waId: data.callerNumber,
          service: data.service || 'General inquiry',
          preferredTime: data.preferredTime,
          message: data.originalMessage,
          profileName: data.callerName,
          source: 'whatsapp_call',
        });
        callState.leadCaptured = true;
        enrichVoiceLead(lead).catch(() => {});
        logVoiceOutcome({ waId: data.callerNumber, outcome: 'lead_captured', durationSecs: Math.round((Date.now() - callState.startTime) / 1000) }).catch(() => {});
        notifyVoiceOwner(lead).catch(()=>{});
        // Notify caller via WhatsApp text as well
        if (data.callerNumber && data.callerNumber !== 'Unknown') {
          sendWhatsAppText(
            data.callerNumber,
            `✅ Hi ${data.name}! Your meeting for *${data.service || 'Launch Craft services'}* at *${time}* is scheduled. The Launch Craft Team will call you within a few minutes on this number. Thank you! 🚀`
          ).catch(()=>{});
        }
        callState.voiceLead = null;
        const confirm = `Thank you ${data.name}! Your meeting for ${data.service || 'Launch Craft services'} at ${time} is scheduled. The Launch Craft Team will reach out to you within a few minutes. We appreciate your interest!`;
        const buf = await synthesizeSpeech(confirm);
        if (buf) playAudioToCall(callId, buf);
        if (callState.processingTimeout) { clearTimeout(callState.processingTimeout); callState.processingTimeout = null; }
        callState.isProcessing = false;
        if (callTimings.has(callId)) { logLatency(callId, callTimings.get(callId)); callTimings.delete(callId); }
        return;
      }
      // fallback clear
      callState.voiceLead = null;
    }

    // Check if new meeting intent -> start collection instead of normal LLM
    if (isVoiceMeetingIntent(text)) {
      console.log(`[${callId}] Voice meeting intent detected: "${text.slice(0,60)}"`);
      if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
      const detectedSvc = detectVoiceService(text);
      callState.voiceLead = {
        step: 'ask_name',
        data: {
          callerNumber: callState.callerNumber,
          callerName: callState.callerName,
          originalMessage: text,
          detectedService: detectedSvc,
        },
      };
      const askName = `Great! I can schedule a call with the Launch Craft Team for you. May I know your name please?`;
      const buf = await synthesizeSpeech(askName);
      if (buf) playAudioToCall(callId, buf);
      if (callState.processingTimeout) { clearTimeout(callState.processingTimeout); callState.processingTimeout = null; }
      callState.isProcessing = false;
      if (callTimings.has(callId)) { logLatency(callId, callTimings.get(callId)); callTimings.delete(callId); }
      return;
    }

    // ---- Real-time search (free) + filler technique ----
    let searchContext = null;
    const shouldSearch = needsWebSearch(text);
    if (shouldSearch) console.log(`[${callId}] Search triggered for: "${text.slice(0, 60)}"`);

    // Filler: if response takes >700ms (search) or >1100ms (no search), speak a short hold phrase
    // so caller doesn't think the call died while we fetch search / wait for LLM.
    let fillerPlayed = false;
    let sentenceCount = 0;
    const fillerDelay = shouldSearch ? 700 : 1100;
    fillerTimer = setTimeout(async () => {
      if (fillerPlayed || sentenceCount > 0) return;
      if (!callState.isProcessing || !activeCalls.has(callId)) return;
      fillerPlayed = true;
      try {
        const fillerText = getFillerText();
        console.log(`[${callId}] Filler triggered (${fillerDelay}ms): "${fillerText}"`);
        const fillerBuf = await synthesizeSpeech(fillerText);
        if (fillerBuf && activeCalls.has(callId) && sentenceCount === 0) {
          playAudioToCall(callId, fillerBuf);
        }
      } catch (e) {
        console.log(`[${callId}] Filler error: ${e.message}`);
      }
    }, fillerDelay);

    if (shouldSearch) {
      const searchStart = Date.now();
      try {
        searchContext = await webSearch(text);
        console.log(`[${callId}] Search done (${Date.now() - searchStart}ms) ${searchContext ? searchContext.length + ' chars' : 'no results'}`);
      } catch (e) {
        console.log(`[${callId}] Search error: ${e.message}`);
      }
    }

    const llmStart = Date.now();
    // T5 — LLM stream start
    const t = callTimings.get(callId) || {};
    t.t5 = Date.now();
    callTimings.set(callId, t);
    let sentenceBuffer = '';

    for await (const token of generateLLMResponseStream(text, searchContext)) {
      if (!callState.pc || callState.pc.connectionState === 'closed') {
        console.log(`[${callId}] LLM streaming interrupted (connection closed)`);
        break;
      }

      sentenceBuffer += token;

      const sentenceEnd = sentenceBuffer.match(/[.!?]+[\s"']*/);
      const shouldFlush = sentenceEnd || sentenceBuffer.length > 80;
      if (shouldFlush) {
        let sentence, rest;
        if (sentenceEnd) {
          const sentenceEndIndex = sentenceBuffer.indexOf(sentenceEnd[0]) + sentenceEnd[0].length;
          sentence = sentenceBuffer.slice(0, sentenceEndIndex).trim();
          rest = sentenceBuffer.slice(sentenceEndIndex);
        } else {
          sentence = sentenceBuffer.trim();
          rest = '';
        }
        sentenceBuffer = rest;

        if (sentence.length > 3) {
          sentenceCount++;
          if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
          // T6 — first sentence flushed to TTS
          if (sentenceCount === 1) {
            const t6 = callTimings.get(callId) || {};
            t6.t6 = Date.now();
            callTimings.set(callId, t6);
          }
          // T7 — TTS start for first sentence
          const isFirstTts = sentenceCount === 1;
          if (isFirstTts) {
            const t7 = callTimings.get(callId) || {};
            t7.t7 = Date.now();
            callTimings.set(callId, t7);
          }
          const ttsStart = Date.now();
          const ttsBuffer = await synthesizeSpeech(sentence);
          const ttsMs = Date.now() - ttsStart;

          if (ttsBuffer) {
            console.log(`[${callId}] Sentence ${sentenceCount} TTS (${ttsMs}ms): ${ttsBuffer.length} bytes`);
            playAudioToCall(callId, ttsBuffer);
            // T8 — first audio frame written
            if (isFirstTts) {
              const t8 = callTimings.get(callId) || {};
              t8.t8 = Date.now();
              callTimings.set(callId, t8);
              logLatency(callId, t8);
              callTimings.delete(callId);
            }
          }
        }
      }
    }

    const remaining = sentenceBuffer.trim();
    if (remaining.length > 0) {
      sentenceCount++;
      if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
      const isFirstRemaining = sentenceCount === 1;
      if (isFirstRemaining) {
        const t6 = callTimings.get(callId) || {};
        t6.t6 = Date.now();
        t6.t7 = Date.now();
        callTimings.set(callId, t6);
      }
      const ttsStart = Date.now();
      const ttsBuffer = await synthesizeSpeech(remaining);
      const ttsMs = Date.now() - ttsStart;

      if (ttsBuffer) {
        console.log(`[${callId}] Sentence ${sentenceCount} TTS (${ttsMs}ms): ${ttsBuffer.length} bytes`);
        playAudioToCall(callId, ttsBuffer);
        if (isFirstRemaining) {
          const t8 = callTimings.get(callId) || {};
          t8.t8 = Date.now();
          callTimings.set(callId, t8);
          logLatency(callId, t8);
          callTimings.delete(callId);
        }
      }
    }

    if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
    const llmMs = Date.now() - llmStart;
    console.log(`[${callId}] LLM stream complete (${llmMs}ms, ${sentenceCount} sentences)`);
    // If no T8 was logged (e.g., no TTS succeeded), log what we have
    if (callTimings.has(callId)) {
      logLatency(callId, callTimings.get(callId));
      callTimings.delete(callId);
    }

    if (callState.processingTimeout) {
      clearTimeout(callState.processingTimeout);
      callState.processingTimeout = null;
    }
    callState.isProcessing = false;

  } catch (err) {
    console.error(`[${callId}] AI error:`, err.message);
    if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
    if (callState.processingTimeout) {
      clearTimeout(callState.processingTimeout);
      callState.processingTimeout = null;
    }
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
    if (callState.processingTimeout) clearTimeout(callState.processingTimeout);
    if (callState.audioSink) { try { callState.audioSink.close(); } catch(e) {} }
    if (callState.audioSource) { try { callState.audioSource.close(); } catch(e) {} }
    if (callState.pc) { try { callState.pc.close(); } catch(e) {} }
    // Outcome logging (free, no deps) — lead_captured already logged, else classify
    if (!callState.leadCaptured && callState.callerNumber) {
      const durationSecs = Math.round((Date.now() - callState.startTime) / 1000);
      const outcome = durationSecs < 10 ? 'abandoned' : 'info_only';
      logVoiceOutcome({ waId: callState.callerNumber, outcome, durationSecs }).catch(() => {});
    }
    activeCalls.delete(callId);
    callTimings.delete(callId);
    console.log(`[${callId}] Cleanup done`);
  }
}

app.get('/api/status', (req, res) => {
  res.json({ status: 'running', activeCalls: activeCalls.size });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ---- Launch Craft Leads API (additive) ----
app.get('/api/leads', async (req, res) => {
  const all = await getLeads();
  res.json({ count: all.length, leads: all });
});
app.get('/api/outcomes', async (req, res) => {
  const all = await getCallOutcomes();
  res.json({ count: all.length, outcomes: all });
});

server.listen(PORT, () => {
  console.log(`StepTalk Voice Agent on port ${PORT}`);
  console.log(`Webhook: https://steptalk.onrender.com/webhook`);
});

// Graceful shutdown (free, no deps) — let active calls finish on Render SIGTERM
let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received, draining ${activeCalls.size} active calls...`);
  server.close(() => {
    console.log('HTTP server closed, waiting for calls to end...');
    const start = Date.now();
    const interval = setInterval(() => {
      if (activeCalls.size === 0 || Date.now() - start > 15000) {
        clearInterval(interval);
        console.log(`Shutdown complete, ${activeCalls.size} calls remaining`);
        process.exit(0);
      }
    }, 1000);
  });
  // Force exit after 20s even if calls hang
  setTimeout(() => {
    console.log('Force exit after 20s');
    process.exit(0);
  }, 20000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
