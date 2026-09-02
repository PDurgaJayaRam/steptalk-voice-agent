// Test different question types and validate LLM responses
// Run: node backend/test_question_types.js

const { generateLLMResponse, generateLLMResponseStream } = require('./ai');

const testCases = [
  // Service Questions
  { input: "What services do you offer?", expect: "services" },
  { input: "Do you build websites?", expect: "website" },
  { input: "Can you make an app for me?", expect: "app" },
  { input: "Do you do marketing?", expect: "marketing" },
  { input: "What is AI automation?", expect: "automation" },
  
  // Pricing Questions
  { input: "How much does a website cost?", expect: "pricing" },
  { input: "What's your budget?", expect: "pricing" },
  { input: "Can you give me a quote?", expect: "pricing" },
  
  // Process Questions
  { input: "How does this work?", expect: "process" },
  { input: "How long does it take?", expect: "timeline" },
  { input: "What's your process?", expect: "process" },
  
  // Meeting/Call Questions
  { input: "I want to talk to someone", expect: "meeting" },
  { input: "Can I schedule a call?", expect: "meeting" },
  { input: "Connect me with your team", expect: "meeting" },
  
  // Company Questions
  { input: "Tell me about your company", expect: "company" },
  { input: "Where are you located?", expect: "location" },
  { input: "Who are your clients?", expect: "clients" },
  
  // Out of Scope
  { input: "What's the weather today?", expect: "fallback" },
  { input: "Tell me a joke", expect: "fallback" },
  { input: "What's your favorite color?", expect: "fallback" },
  
  // Off-topic Recovery
  { input: "Can you help me with my tax return?", expect: "fallback" },
  { input: "Do you sell clothes?", expect: "fallback" },
];

async function runTests() {
  console.log("=== Testing LLM Responses for Different Question Types ===\n");
  
  let passed = 0;
  let failed = 0;
  
  for (const test of testCases) {
    process.stdout.write(`Q: "${test.input}" ... `);
    
    try {
      const response = await generateLLMResponse(test.input);
      const lower = response.toLowerCase();
      
      // Check response quality
      const checks = {
        hasContent: response.length > 5,
        isShort: response.split(' ').length <= 40,
        endsWithPunctuation: /[.?!]$/.test(response.trim()),
        noMarkdown: !response.includes('**') && !response.includes('- '),
        noEmoji: !response.match(/[\u{1F600}-\u{1F64F}]/u),
      };
      
      const allPassed = Object.values(checks).every(v => v);
      
      if (allPassed) {
        console.log(`✓ PASS`);
        console.log(`  Response: "${response.substring(0, 80)}..."`);
        passed++;
      } else {
        console.log(`✗ FAIL`);
        console.log(`  Response: "${response.substring(0, 80)}..."`);
        console.log(`  Checks:`, checks);
        failed++;
      }
    } catch (error) {
      console.log(`✗ ERROR: ${error.message}`);
      failed++;
    }
  }
  
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
}

runTests().catch(console.error);
