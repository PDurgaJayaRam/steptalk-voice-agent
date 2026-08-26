const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { generateLLMResponse, synthesizeSpeech } = require('./ai');

const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || '1244323078774535';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const API_VERSION = 'v26.0';

async function handleInboundCall(callData, activeCalls) {
  const { id: callId, from, session } = callData;

  console.log(`📞 Handling inbound call from ${from}, callId: ${callId}`);
  console.log(`📞 Session SDP type: ${session?.sdp_type}`);
  console.log(`📞 Session SDP length: ${session?.sdp?.length}`);

  activeCalls[callId] = {
    callId,
    from,
    status: 'ringing',
    startTime: Date.now(),
    sdp: session?.sdp
  };

  try {
    if (session?.sdp && session?.sdp_type === 'offer') {
      console.log(`📞 Received SDP offer, creating answer...`);
      
      const sdpAnswer = createSDPAnswer(session.sdp);
      console.log(`📞 SDP answer created, pre-accepting call...`);
      
      await preAcceptCall(callId, sdpAnswer);
      activeCalls[callId].status = 'pre-accepted';
      console.log(`📞 Call ${callId} pre-accepted`);

      setTimeout(async () => {
        try {
          await acceptCall(callId);
          activeCalls[callId].status = 'accepted';
          console.log(`📞 Call ${callId} fully accepted`);
        } catch (err) {
          console.error('Error accepting call:', err.message);
        }
      }, 1000);
    } else {
      console.log(`📞 No SDP offer found, trying to accept directly...`);
      await acceptCall(callId);
      activeCalls[callId].status = 'accepted';
    }
  } catch (error) {
    console.error('Error handling inbound call:', error.message);
  }
}

function createSDPAnswer(sdpOffer) {
  const lines = sdpOffer.split('\r\n');
  const answerLines = [];
  let audioPayloadType = 111;
  let audioPort = 9;

  for (const line of lines) {
    if (line.startsWith('m=audio')) {
      const parts = line.split(' ');
      audioPort = parseInt(parts[1]) || 9;
      const codecs = parts.slice(3);
      const opusCodec = codecs.find(c => c === '111');
      if (opusCodec) {
        audioPayloadType = 111;
      } else if (codecs.length > 0) {
        audioPayloadType = parseInt(codecs[0]) || 111;
      }
      answerLines.push(`m=audio ${audioPort} UDP/TLS/RTP/SAVPF ${audioPayloadType}`);
    } else if (line.startsWith('c=IN')) {
      answerLines.push('c=IN IP4 0.0.0.0');
    } else if (line.startsWith('a=rtpmap:111') || line.startsWith(`a=rtpmap:${audioPayloadType}`)) {
      answerLines.push(`a=rtpmap:${audioPayloadType} opus/48000/2`);
    } else if (line.startsWith('a=fmtp:111') || line.startsWith(`a=fmtp:${audioPayloadType}`)) {
      answerLines.push(`a=fmtp:${audioPayloadType} minptime=10; useinbandfec=1`);
    } else if (line.startsWith('a=setup:')) {
      answerLines.push('a=setup:active');
    } else if (line.startsWith('a=mid:')) {
      answerLines.push(line);
    } else if (line.startsWith('v=') || line.startsWith('o=') || line.startsWith('s=') || line.startsWith('t=')) {
      answerLines.push(line);
    } else if (line.startsWith('a=ice-') || line.startsWith('a=fingerprint:') || line.startsWith('a=group:')) {
      answerLines.push(line);
    }
  }

  if (!answerLines.some(l => l.startsWith('a=sendrecv'))) {
    answerLines.push('a=sendrecv');
  }

  return answerLines.join('\r\n') + '\r\n';
}

async function preAcceptCall(callId, sdpAnswer) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/calls`;

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
  console.log('Pre-accept response:', JSON.stringify(data));
  return data;
}

async function acceptCall(callId) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/calls`;

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
  console.log('Accept response:', JSON.stringify(data));
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
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/calls`;

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
  console.log('Reject response:', JSON.stringify(data));
  return data;
}

module.exports = {
  handleInboundCall,
  acceptCall,
  terminateCall,
  rejectCall
};
