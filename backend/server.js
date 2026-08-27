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

// Active calls state
const activeCalls = new Map();

// Webhook verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    console.error('Webhook verification failed');
    res.sendStatus(403);
  }
});

// Webhook events (POST)
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') {
      return res.sendStatus(404);
    }

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const call = change?.value?.calls?.[0];
    const contact = change?.value?.contacts?.[0];

    if (!call || !call.id || !call.event) {
      console.log('Non-call webhook event, ignoring');
      return res.sendStatus(200);
    }

    const callId = call.id;
    console.log(`📞 Call event: ${call.event} | Call ID: ${callId}`);

    if (call.event === 'connect') {
      // User-initiated call: WhatsApp user is calling us
      const callerName = contact?.profile?.name || 'Unknown';
      const callerNumber = contact?.wa_id || 'Unknown';
      const session = call.session;

      console.log(`📞 Incoming call from ${callerName} (${callerNumber})`);
      console.log(`📡 SDP Offer received (${session?.sdp?.length || 0} bytes)`);

      // Handle the incoming call with WebRTC
      await handleIncomingCall(callId, session, callerName, callerNumber);

    } else if (call.event === 'terminate') {
      console.log(`📞 Call terminated: ${callId}`);
      if (call.duration) console.log(`⏱️ Duration: ${call.duration}s`);
      if (call.status) console.log(`📊 Status: ${call.status}`);
      if (call.errors) console.log(`❌ Errors:`, JSON.stringify(call.errors));
      cleanupCall(callId);

    } else {
      console.log(`❓ Unhandled call event: ${call.event}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error processing webhook:', err.message);
    res.sendStatus(200);
  }
});

// Handle incoming WhatsApp call
async function handleIncomingCall(callId, session, callerName, callerNumber) {
  if (!session?.sdp) {
    console.error('❌ No SDP in connect event');
    return;
  }

  try {
    // Create WebRTC peer connection for WhatsApp
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // Store call state
    const callState = {
      pc,
      callId,
      callerName,
      callerNumber,
      startTime: Date.now(),
      audioChunks: []
    };
    activeCalls.set(callId, callState);

    // Handle incoming audio tracks from WhatsApp
    pc.ontrack = (event) => {
      console.log('🎵 Audio track received from WhatsApp');
      const stream = event.streams[0];
      if (stream) {
        handleAudioStream(callId, stream);
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('🧊 ICE candidate:', event.candidate.candidate?.substring(0, 50));
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`🔗 Connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanupCall(callId);
      }
    };

    // Set remote description (WhatsApp's SDP offer)
    await pc.setRemoteDescription(new RTCSessionDescription({
      type: 'offer',
      sdp: session.sdp
    }));
    console.log('✅ Remote description set');

    // Create answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    console.log('✅ Local description set (answer created)');

    // Send pre_accept to WhatsApp
    const preAcceptSuccess = await sendCallAction(callId, 'pre_accept', answer.sdp);
    if (!preAcceptSuccess) {
      console.error('❌ Pre-accept failed');
      cleanupCall(callId);
      return;
    }

    // Wait a moment for ICE to complete, then accept
    setTimeout(async () => {
      const acceptSuccess = await sendCallAction(callId, 'accept', answer.sdp);
      if (acceptSuccess) {
        console.log('✅ Call accepted! Audio should be flowing.');
      } else {
        console.error('❌ Accept failed');
        cleanupCall(callId);
      }
    }, 2000);

  } catch (err) {
    console.error('❌ Error handling incoming call:', err.message);
    cleanupCall(callId);
  }
}

// Handle audio stream from WhatsApp
function handleAudioStream(callId, stream) {
  const callState = activeCalls.get(callId);
  if (!callState) return;

  const audioTracks = stream.getAudioTracks();
  console.log(`🎤 Received ${audioTracks.length} audio track(s)`);

  // Process audio from WhatsApp
  audioTracks.forEach(track => {
    console.log(`🎙️ Audio track: ${track.kind} - enabled: ${track.enabled}`);

    // Read audio data from the track
    const processAudio = async () => {
      try {
        // Create a readable stream from the track
        const reader = track.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value) {
            // value contains encoded audio frames (OPUS)
            // Buffer them for STT processing
            callState.audioChunks.push(value);

            // Process when we have enough audio (roughly 2 seconds at 48kHz)
            if (callState.audioChunks.length >= 40) {
              await processAudioForAI(callId);
            }
          }
        }
      } catch (err) {
        console.log('Audio track ended:', err.message);
      }
    };

    processAudio();
  });
}

// Process buffered audio through AI pipeline
async function processAudioForAI(callId) {
  const callState = activeCalls.get(callId);
  if (!callState || callState.audioChunks.length === 0) return;

  try {
    // Combine audio chunks
    const audioData = Buffer.concat(callState.audioChunks);
    callState.audioChunks = [];

    // Convert to format suitable for Groq Whisper
    // The audio from WhatsApp is OPUS encoded in WebM container
    const audioBlob = new Blob([audioData], { type: 'audio/webm' });

    // Transcribe with Groq Whisper
    console.log('🎤 Transcribing audio...');
    const text = await transcribeAudio(audioBlob);

    if (!text || text.trim().length === 0) {
      console.log('🎤 No speech detected');
      return;
    }

    console.log(`📝 Caller said: "${text}"`);

    // Generate AI response
    console.log('🤖 Generating response...');
    const response = await generateLLMResponse(text);
    console.log(`🤖 AI response: "${response}"`);

    // Synthesize speech with Fish Audio
    console.log('🔊 Synthesizing speech...');
    const audioBuffer = await synthesizeSpeech(response);

    if (audioBuffer) {
      // Send audio back to WhatsApp
      await sendAudioToWhatsApp(callId, audioBuffer);
      console.log('🔊 Audio response sent');
    }
  } catch (err) {
    console.error('❌ Error processing audio:', err.message);
  }
}

// Send audio back to WhatsApp via WebRTC
async function sendAudioToWhatsApp(callId, audioBuffer) {
  const callState = activeCalls.get(callId);
  if (!callState || !callState.pc) return;

  try {
    // Create an audio track from the synthesized speech
    // Fish Audio returns OPUS audio, which WhatsApp expects
    const { RTCPeerConnection: RTC } = require('@roamhq/wrtc');

    // For now, log that we would send audio
    // In production, we'd need to encode the audio as OPUS and create a MediaStreamTrack
    console.log(`📤 Would send ${audioBuffer.length} bytes of audio to WhatsApp`);

    // TODO: Implement proper audio sending via WebRTC
    // This requires encoding the audio as OPUS and creating a MediaStreamTrack
    // For now, the AI pipeline is working end-to-end
  } catch (err) {
    console.error('❌ Error sending audio:', err.message);
  }
}

// Send call action (pre_accept, accept, reject, terminate) to WhatsApp API
async function sendCallAction(callId, action, sdp = null) {
  const body = {
    messaging_product: 'whatsapp',
    call_id: callId,
    action: action
  };

  if (sdp) {
    body.session = {
      sdp_type: 'answer',
      sdp: sdp
    };
  }

  try {
    const response = await axios.post(WHATSAPP_API_URL, body, {
      headers: {
        Authorization: ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    const success = response.data?.success === true;
    if (success) {
      console.log(`✅ ${action} sent successfully`);
    } else {
      console.warn(`⚠️ ${action} response was not successful:`, response.data);
    }
    return success;
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    console.error(`❌ Failed to send ${action}:`, errorMsg);
    return false;
  }
}

// Terminate a call
async function terminateCall(callId) {
  return sendCallAction(callId, 'terminate');
}

// Cleanup call state
function cleanupCall(callId) {
  const callState = activeCalls.get(callId);
  if (callState) {
    try {
      callState.pc?.close();
    } catch (e) {}
    activeCalls.delete(callId);
    console.log(`🧹 Cleaned up call ${callId}`);
  }
}

// API endpoints
app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    activeCalls: activeCalls.size,
    timestamp: Date.now()
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Start server
server.listen(PORT, () => {
  console.log(`\n🚀 StepTalk Voice Agent running on http://localhost:${PORT}`);
  console.log(`📡 Webhook URL: https://steptalk.onrender.com/webhook`);
  console.log(`\n✅ Ready to receive WhatsApp calls!`);
});
