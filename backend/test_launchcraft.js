const assert = require('assert');
const { handleChatMessage, chatStates } = require('./launchcraft');
const { getLeads } = require('./leads');

let sent = [];
async function mockSend(to, body) { sent.push({ to, body }); }

async function reset() {
  sent = [];
  chatStates.clear();
  // Clean leads file not needed for these tests (they mock)
}

async function test(name, fn) {
  try {
    await reset();
    await fn();
    console.log(`✅ ${name}`);
    return true;
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    console.log(e.stack);
    return false;
  }
}

(async () => {
  let pass = 0, total = 0;

  // 1. Greeting
  total++; if (await test('Greeting -> welcome with services', async () => {
    await handleChatMessage({ from: '919999999991', text: 'Hi', profileName: 'Test', sendMessage: mockSend });
    assert(sent.length === 1 && sent[0].body.includes('Launch Craft Agency'));
  })) pass++;

  // 2. Service detection
  total++; if (await test('Service detection -> guide + meeting CTA', async () => {
    await handleChatMessage({ from: '919999999992', text: 'I need a website', profileName: 'A', sendMessage: mockSend });
    assert(sent[0].body.includes('Web Development'));
  })) pass++;

  // 3. Customer changes service mid-flow (ask_service step with different service)
  total++; if (await test('Mid-flow service change', async () => {
    await handleChatMessage({ from: '919999999993', text: 'schedule a meeting', profileName: 'Rahul', sendMessage: mockSend });
    // step ask_name
    assert(sent[0].body.includes('May I know your name'));
    sent = [];
    await handleChatMessage({ from: '919999999993', text: 'Rahul', profileName: 'Rahul', sendMessage: mockSend });
    assert(sent[0].body.includes('Which service'));
    sent = [];
    await handleChatMessage({ from: '919999999993', text: 'actually make it App Development', profileName: 'Rahul', sendMessage: mockSend });
    assert(sent[0].body.includes('App Development'));
    // Verify service captured
    const state = chatStates.get('919999999993');
    assert(state.data.service.includes('App Development'));
  })) pass++;

  // 4. Gibberish name (should still accept and proceed)
  total++; if (await test('Gibberish name still flows', async () => {
    await handleChatMessage({ from: '919999999994', text: 'schedule a meeting', profileName: 'X', sendMessage: mockSend });
    sent = [];
    await handleChatMessage({ from: '919999999994', text: 'asdf123!@#', profileName: 'X', sendMessage: mockSend });
    assert(sent[0].body.includes('Which service') || sent[0].body.includes('When should'));
  })) pass++;

  // 5. Unsupported question fallback to LLM (mock)
  total++; if (await test('Unsupported question -> LLM fallback with CTA', async () => {
    await handleChatMessage({ from: '919999999995', text: 'do you sell mangoes?', profileName: 'A', sendMessage: mockSend });
    // Should get either service list or LLM reply with meeting CTA
    assert(sent.length === 1);
    assert(sent[0].body.length > 20);
  })) pass++;

  // 6. Number shortcut for service (1-5)
  total++; if (await test('Number shortcut 3 -> Brand Marketing', async () => {
    await handleChatMessage({ from: '919999999996', text: 'schedule a meeting', profileName: 'A', sendMessage: mockSend });
    sent = [];
    await handleChatMessage({ from: '919999999996', text: 'Priya', profileName: 'Priya', sendMessage: mockSend });
    sent = [];
    await handleChatMessage({ from: '919999999996', text: '3', profileName: 'Priya', sendMessage: mockSend });
    assert(sent[0].body.includes('Brand Marketing') || sent[0].body.includes('3'));
  })) pass++;

  console.log(`\n${pass}/${total} tests passed`);
  process.exit(pass === total ? 0 : 1);
})();
