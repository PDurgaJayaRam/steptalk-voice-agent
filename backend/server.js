require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { handleInboundCall, answerCall, terminateCall } = require('./calling');
const { generateLLMResponse, synthesizeSpeech } = require('./ai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || 'steptalk-verify-123';
const APP_SECRET = process.env.META_APP_SECRET;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '1244323078774535';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

let activeCalls = {};

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;

  if (body.object !== 'whatsapp_business_account') return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'calls') {
        await handleCallWebhook(change.value);
      }
      if (change.field === 'messages') {
        await handleMessageWebhook(change.value);
      }
    }
  }
});

async function handleCallWebhook(value) {
  const call = value.calls?.[0];
  if (!call) return;

  console.log(`📞 Call event: ${call.event} from ${call.from}`);

  switch (call.event) {
    case 'connect':
      await handleInboundCall(call, activeCalls);
      break;
    case 'terminate':
      await terminateCall(call, activeCalls);
      break;
    default:
      console.log(`Unknown call event: ${call.event}`);
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
    timestamp: Date.now()
  });
});

app.get('/api/calls', (req, res) => {
  res.json({ calls: activeCalls });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🚀 StepTalk Voice Agent running on http://localhost:${PORT}`);
  console.log(`\n📞 Webhook URL: https://steptalk.onrender.com/webhook`);
  console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
  console.log(`\n📋 Next steps:`);
  console.log(`   1. Enable calling on your WhatsApp number`);
  console.log(`   2. Configure webhook in Meta dashboard`);
  console.log(`   3. Test by calling +1 555 199 0540`);
});
