const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');

(async () => {
  const tts = new MsEdgeTTS();
  await tts.setMetadata('en-US-GuyNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream('Hello! Welcome to StepTalk. How can I help you today?');
  const chunks = [];
  audioStream.on('data', (chunk) => chunks.push(chunk));
  audioStream.on('end', () => {
    const buf = Buffer.concat(chunks);
    fs.writeFileSync('C:/Users/Durga\'s PC/Downloads/edge_test.mp3', buf);
    console.log('Written:', buf.length, 'bytes');
  });
  audioStream.on('error', (e) => console.error('Error:', e.message));
})();
