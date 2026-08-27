require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const axios = require('axios');
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
      console.log('Non-call event, ignoring');
      return res.sendStatus(200);
    }

    const callId = call.id;
    console.log(`Call event: ${call.event} | ID: ${callId}`);

    if (call.event === 'connect') {
      const callerName = contact?.profile?.name || 'Unknown';
      const callerNumber = contact?.wa_id || 'Unknown';
      const session = call.session;

      console.log(`Incoming call from ${callerName} (${callerNumber})`);
      console.log(`SDP Offer (${session?.sdp?.length || 0} bytes):`);
      console.log(session?.sdp);

      activeCalls.set(callId, {
        callId, callerName, callerNumber,
        startTime: Date.now(), audioChunks: []
      });

      await answerCall(callId, session);

    } else if (call.event === 'terminate') {
      console.log(`Call terminated: ${callId} | Duration: ${call.duration || '?'}s | Status: ${call.status || '?'}`);
      if (call.errors) console.log(`Errors:`, JSON.stringify(call.errors));
      activeCalls.delete(callId);

    } else {
      console.log(`Unhandled event: ${call.event}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.sendStatus(200);
  }
});

async function answerCall(callId, session) {
  if (!session?.sdp) {
    console.error('No SDP in offer');
    return;
  }

  const sdp = session.sdp;

  const hasFingerprint = sdp.includes('a=fingerprint:');
  const hasDtlsSetup = sdp.includes('a=setup:');
  const hasIceUfrag = sdp.includes('a=ice-ufrag:');
  const hasMsid = sdp.includes('a=msid:');
  const hasSsrc = sdp.includes('a=ssrc:');

  console.log(`SDP analysis: fingerprint=${hasFingerprint} dtls=${hasDtlsSetup} ice=${hasIceUfrag} msid=${hasMsid} ssrc=${hasSsrc}`);

  const preOk = await sendAction(callId, 'pre_accept', sdp);
  if (!preOk) {
    console.error('Pre-accept failed');
    return;
  }

  setTimeout(async () => {
    const acceptOk = await sendAction(callId, 'accept', sdp);
    if (acceptOk) {
      console.log('Call accepted! Audio should be flowing.');
    } else {
      console.error('Accept failed');
    }
  }, 2000);
}

async function sendAction(callId, action, sdp = null) {
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
      headers: { Authorization: ACCESS_TOKEN, 'Content-Type': 'application/json' }
    });
    const success = response.data?.success === true;
    console.log(`${action}: ${success ? 'OK' : 'FAIL'} - ${JSON.stringify(response.data)}`);
    return success;
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error(`${action} error:`, msg);
    return false;
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
