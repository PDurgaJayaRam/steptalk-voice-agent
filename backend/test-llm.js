require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

async function testLLM() {
  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`
    },
    body: JSON.stringify({
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      messages: [
        { role: 'system', content: 'You are StepTalk AI. Reply with ONLY your final answer text. No reasoning, no analysis, no thinking.' },
        { role: 'user', content: 'Can you hear me?' }
      ],
      stream: false,
      max_tokens: 1024,
      temperature: 0.3
    })
  });
  const data = await response.json();
  const content = data.choices[0].message.content;
  const match = content.match(/"([^"]+)"\s*$/);
  console.log('Raw:', content.slice(-300));
  console.log('Extracted:', match ? match[1] : 'NO MATCH');
}
testLLM();
