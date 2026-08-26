# StepTalk - Inbound WhatsApp Voice Agent

Free AI voice agent that answers incoming WhatsApp calls.

## Architecture

```
User calls +1 555 199 0540
       ↓
Meta Cloud API receives call
       ↓
Webhook → Our Server
       ↓
SDP negotiation (answer the call)
       ↓
Caller speaks → STT → NVIDIA NIM → Fish Audio TTS
       ↓
AI voice response sent back to caller
```

## What You Need to Do

### Step 1: Enable Calling on Your WhatsApp Number

Run this command in terminal (replace ACCESS_TOKEN with your fresh token):

```bash
curl -X POST "https://graph.facebook.com/v21.0/12443230774535/settings" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"calling": {"status": "ENABLED"}}'
```

### Step 2: Configure Webhook in Meta Dashboard

1. Go to https://developers.facebook.com
2. Select your app (StepTalk)
3. Go to WhatsApp → Configuration
4. Under Webhooks, click "Edit"
5. Enter:
   - Callback URL: `https://steptalk.onrender.com/webhook`
   - Verify Token: `steptalk-verify-123`
6. Click "Verify and Save"
7. Subscribe to `calls` field

### Step 3: Generate Fresh Access Token

1. Go to WhatsApp → API Setup
2. Click "Generate Access Token"
3. Copy the token
4. Update `backend/.env` file with the new token

### Step 4: Deploy to Render

1. Push code to GitHub
2. Deploy on Render
3. Set environment variables in Render dashboard

### Step 5: Test

1. Open WhatsApp on your phone
2. Call +1 555 199 0540
3. AI should answer

## Files

- `server.js` - Main server with webhook handling
- `calling.js` - WhatsApp call WebRTC/SDP handling
- `ai.js` - Fish Audio TTS + NVIDIA NIM integration
- `.env` - Environment variables (API keys)
