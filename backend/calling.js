const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { generateLLMResponse, synthesizeSpeech } = require('./ai');

const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '1244323078774535';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

async function handleInboundCall(callData, activeCalls) {
  const { id: callId, from, session } = callData;

  console.log(`📞 Handling inbound call from ${from}, callId: ${callId}`);

  activeCalls[callId] = {
    callId,
    from,
    status: 'ringing',
    startTime: Date.now(),
    sdp: session?.sdp
  };

  try {
    const sdpAnswer = await createSDPAnswer(session.sdp);

    await preAcceptCall(callId, sdpAnswer);

    activeCalls[callId].status = 'pre-accepted';
    console.log(`📞 Call ${callId} pre-accepted`);

  } catch (error) {
    console.error('Error handling inbound call:', error);
    await rejectCall(callId);
  }
}

async function createSDPAnswer(sdpOffer) {
  const lines = sdpOffer.split('\r\n');
  const answerLines = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=StepTalk AI',
    't=0 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10; useinbandfec=1',
    'a=sendrecv',
    'a=setup:active',
    'a=mid:0'
  ];

  return answerLines.join('\r\n') + '\r\n';
}

async function preAcceptCall(callId, sdpAnswer) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/calls`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      call_id: callId,
      action: 'pre_accept',
      session: {
        sdp: sdpAnswer,
        sdp_type: 'answer'
      }
    })
  });

  const data = await response.json();
  console.log('Pre-accept response:', data);
  return data;
}

async function acceptCall(callId) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/calls`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      call_id: callId,
      action: 'accept'
    })
  });

  const data = await response.json();
  console.log('Accept response:', data);
  return data;
}

async function terminateCall(callData, activeCalls) {
  const { id: callId } = callData;

  console.log(`📞 Terminating call ${callId}`);

  if (activeCalls[callId]) {
    const duration = Math.floor((Date.now() - activeCalls[callId].startTime) / 1000);
    console.log(`📞 Call ${callId} lasted ${duration} seconds`);
    delete activeCalls[callId];
  }
}

async function rejectCall(callId) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/calls`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      call_id: callId,
      action: 'reject'
    })
  });

  const data = await response.json();
  console.log('Reject response:', data);
  return data;
}

module.exports = {
  handleInboundCall,
  acceptCall,
  terminateCall,
  rejectCall
};
