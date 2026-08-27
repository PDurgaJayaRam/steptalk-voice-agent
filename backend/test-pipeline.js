require('dotenv').config();
const { generateLLMResponse, synthesizeSpeech, transcribeAudio } = require('./ai');

async function testPipeline() {
  // Test 1: Groq LLM
  console.log('--- Test 1: Groq LLM ---');
  const llmResponse = await generateLLMResponse('What is your name?');
  console.log('LLM Response:', llmResponse);

  // Test 2: Fish Audio TTS
  console.log('\n--- Test 2: Fish Audio TTS ---');
  const ttsBuffer = await synthesizeSpeech(llmResponse);
  if (ttsBuffer) {
    console.log('TTS Buffer:', ttsBuffer.length, 'bytes');
    const fs = require('fs');
    fs.writeFileSync('C:/Users/Durga\'s PC/Downloads/tts_test.wav', ttsBuffer);
    console.log('Saved to Downloads/tts_test.wav');
  } else {
    console.log('TTS FAILED');
  }
}

testPipeline().catch(console.error);
