require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { handleInboundCall, acceptCall, terminateCall } = require('./calling');
const { generateLLMResponse, synthesizeSpeech } = require('./ai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'steptalk-verify-123';
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '1244323078774535';

let activeCalls = {};

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`🔗 Webhook verification: mode=${mode}, token=${token}`);

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;

  if (body.object !== 'whatsapp_business_account') {
    console.log('⚠️ Not a WhatsApp business account event');
    return;
  }

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      console.log(`📨 Webhook event: ${change.field}`);

      if (change.field === 'calls') {
        console.log('📞 Call event received:', JSON.stringify(change.value, null, 2));
        await handleCallWebhook(change.value);
      }
      if (change.field === 'messages') {
        console.log('💬 Message event received');
        await handleMessageWebhook(change.value);
      }
    }
  }
});

async function handleCallWebhook(value) {
  const call = value.calls?.[0];
  if (!call) {
    console.log('⚠️ No call data in webhook');
    return;
  }

  console.log(`📞 Call event: ${call.event} from ${call.from}, callId: ${call.id}`);

  switch (call.event) {
    case 'connect':
      console.log('📞 Inbound call connecting...');
      await handleInboundCall(call, activeCalls);
      break;
    case 'terminate':
      console.log('📞 Call terminating...');
      await terminateCall(call, activeCalls);
      break;
    case 'ringing':
      console.log('📞 Call is ringing...');
      break;
    case 'accepted':
      console.log('📞 Call accepted by user');
      break;
    case 'rejected':
      console.log('📞 Call rejected');
      break;
    default:
      console.log(`📞 Unknown call event: ${call.event}`);
  }
}

async function handleMessageWebhook(value) {
  const messages = value.messages || [];
  for (const message of messages) {
    if (message.type === 'text') {
      console.log(`📩 Text message from ${message.from}: ${message.text.body}`);
    }
  }
}

app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    activeCalls: Object.keys(activeCalls).length,
    calls: activeCalls,
    timestamp: Date.now()
  });
});

app.get('/api/calls', (req, res) => {
  res.json({ calls: activeCalls });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🚀 StepTalk Voice Agent running on http://localhost:${PORT}`);
  console.log(`\n📞 Webhook URL: https://steptalk.onrender.com/webhook`);
  console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
  console.log(`📱 Phone Number ID: ${PHONE_NUMBER_ID}`);
  console.log(`\n✅ Server ready to receive calls!`);
});
