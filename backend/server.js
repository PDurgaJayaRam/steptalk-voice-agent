require('dotenv').config();
const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');
const { generateLLMResponse, synthesizeSpeech, transcribeAudio } = require('./ai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const PORT = process.env.PORT || 8080;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws/audio' });

let activeCalls = {};

wss.on('connection', (ws) => {
  console.log('🔌 New WebSocket connection for audio');

  const callId = Date.now().toString();
  activeCalls[callId] = { ws, startTime: Date.now(), audioChunks: [] };

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === 'audio') {
        console.log(`🎤 Received audio chunk (${data.length} bytes)`);
        activeCalls[callId].audioChunks.push(Buffer.from(message.data, 'base64'));

        if (activeCalls[callId].audioChunks.length >= 5) {
          const audioBuffer = Buffer.concat(activeCalls[callId].audioChunks);
          activeCalls[callId].audioChunks = [];

          const text = await transcribeAudio(audioBuffer);
          if (text) {
            console.log(`📝 Caller said: ${text}`);
            const response = await generateLLMResponse(text);
            console.log(`🤖 AI response: ${response}`);

            const audioData = await synthesizeSpeech(response);
            if (audioData) {
              ws.send(JSON.stringify({
                type: 'audio',
                data: audioData.toString('base64')
              }));
              console.log(`🔊 Sent audio response`);
            }
          }
        }
      }

      if (message.type === 'text') {
        console.log(`💬 Caller said: ${message.text}`);
        const response = await generateLLMResponse(message.text);
        console.log(`🤖 AI response: ${response}`);

        const audioData = await synthesizeSpeech(response);
        if (audioData) {
          ws.send(JSON.stringify({
            type: 'audio',
            data: audioData.toString('base64')
          }));
          console.log(`🔊 Sent audio response`);
        }
      }
    } catch (err) {
      console.error('WebSocket message error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log(`📞 Call ${callId} ended`);
    delete activeCalls[callId];
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'running',
    activeCalls: Object.keys(activeCalls).length,
    timestamp: Date.now()
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

server.listen(PORT, () => {
  console.log(`\n🚀 StepTalk Voice Agent running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket audio endpoint: ws://localhost:${PORT}/ws/audio`);
  console.log(`\n✅ Ready to receive calls from 3CX!`);
});
