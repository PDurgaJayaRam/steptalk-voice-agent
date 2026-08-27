require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const axios = require('axios');
const { RTCPeerConnection, RTCSessionDescription } = require('@roamhq/wrtc');
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
    console.error('Webhook verification failed');
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

    if (!call || !call.id || !call.event) {
      return res.sendStatus(200);
    }

    const callId = call.id;
    console.log(`Call event: ${call.event} | ID: ${callId}`);

    if (call.event === 'connect') {
      const callerName = contact?.profile?.name || 'Unknown';
      const callerNumber = contact?.wa_id || 'Unknown';
      const session = call.session;

      console.log(`Incoming call from ${callerName} (${callerNumber})`);
      console.log(`SDP Offer (${session?.sdp?.length || 0} bytes)`);

      await handleIncomingCall(callId, session, callerName, callerNumber);

    } else if (call.event === 'terminate') {
      console.log(`Call terminated: ${callId} | Duration: ${call.duration || '?'}s`);
      if (call.errors) console.log(`Errors:`, JSON.stringify(call.errors));
      cleanupCall(callId);
    } else {
      console.log(`Unhandled event: ${call.event}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(200);
  }
});

async function handleIncomingCall(callId, session, callerName, callerNumber) {
  if (!session?.sdp) {
    console.error('No SDP in offer');
    return;
  }

  try {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    const callState = {
      pc, callId, callerName, callerNumber,
      startTime: Date.now(), audioChunks: []
    };
    activeCalls.set(callId, callState);

    pc.ontrack = (event) => {
      console.log('Audio track received from WhatsApp');
      const stream = event.streams[0];
      if (stream) handleAudioStream(callId, stream);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('ICE candidate:', event.candidate.candidate?.substring(0, 80));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`Connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanupCall(callId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`ICE connection state: ${pc.iceConnectionState}`);
    };

    console.log('Setting remote description...');
    await pc.setRemoteDescription(new RTCSessionDescription({
      type: 'offer',
      sdp: session.sdp
    }));
    console.log('Remote description set OK');

    console.log('Creating answer...');
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log(`Answer created (${answer.sdp.length} bytes)`);

    const preOk = await sendAction(callId, 'pre_accept', answer.sdp);
    if (!preOk) {
      console.error('Pre-accept failed');
      cleanupCall(callId);
      return;
    }

    setTimeout(async () => {
      const acceptOk = await sendAction(callId, 'accept', answer.sdp);
      if (acceptOk) {
        console.log('Call accepted! Waiting for audio...');
      } else {
        console.error('Accept failed');
        cleanupCall(callId);
      }
    }, 2000);

  } catch (err) {
    console.error('Error handling call:', err.message);
    cleanupCall(callId);
  }
}

function handleAudioStream(callId, stream) {
  const callState = activeCalls.get(callId);
  if (!callState) return;

  const audioTracks = stream.getAudioTracks();
  console.log(`Received ${audioTracks.length} audio track(s)`);

  audioTracks.forEach(track => {
    const processAudio = async () => {
      try {
        const reader = track.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            callState.audioChunks.push(value);
            if (callState.audioChunks.length >= 40) {
              await processAudioForAI(callId);
            }
          }
        }
      } catch (err) {
        console.log('Audio track ended');
      }
    };
    processAudio();
  });
}

async function processAudioForAI(callId) {
  const callState = activeCalls.get(callId);
  if (!callState || callState.audioChunks.length === 0) return;

  try {
    const audioData = Buffer.concat(callState.audioChunks);
    callState.audioChunks = [];
    const audioBlob = new Blob([audioData], { type: 'audio/webm' });

    console.log('Transcribing...');
    const text = await transcribeAudio(audioBlob);
    if (!text || text.trim().length === 0) return;

    console.log(`Caller said: "${text}"`);
    const response = await generateLLMResponse(text);
    console.log(`AI: "${response}"`);

    const audioBuffer = await synthesizeSpeech(response);
    if (audioBuffer) {
      console.log(`TTS: ${audioBuffer.length} bytes`);
    }
  } catch (err) {
    console.error('AI error:', err.message);
  }
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
    console.error(`${action} error:`, error.response?.data?.error?.message || error.message);
    return false;
  }
}

function cleanupCall(callId) {
  const callState = activeCalls.get(callId);
  if (callState) {
    try { callState.pc?.close(); } catch (e) {}
    activeCalls.delete(callId);
    console.log(`Cleaned up call ${callId}`);
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
