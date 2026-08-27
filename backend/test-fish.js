const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require('fs');

(async () => {
  const response = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer sk-fish-eMn57xwv1drn6Gzh3eTFmd6p4zFshPDibgaQpYlbZ0M',
      'model': 's2.1-pro-free'
    },
    body: JSON.stringify({
      text: 'Hello, this is StepTalk AI. How can I help you today?',
      reference_id: 'ca6a0e466ed34d2ba98dcde5b24d8cc8',
      format: 'wav'
    })
  });
  if (!response.ok) {
    console.error('Error:', response.status, await response.text());
    return;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync('C:/Users/Durga\'s PC/Downloads/fish_free_wav.wav', buffer);
  console.log('Written:', buffer.length, 'bytes');
})();
