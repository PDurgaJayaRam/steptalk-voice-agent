const fs = require('fs');
const path = require('path');
const axios = require('axios');

const LEADS_FILE = path.join(__dirname, 'leads.json');
const OWNER_NUMBER = '918790406516'; // +91 8790406516

let leads = [];

// Load existing leads on startup
try {
  if (fs.existsSync(LEADS_FILE)) {
    leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
    console.log(`[Leads] Loaded ${leads.length} leads`);
  }
} catch (e) {
  console.log('[Leads] No existing leads file, starting fresh');
  leads = [];
}

function saveLead(lead) {
  lead.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  lead.createdAt = new Date().toISOString();
  leads.push(lead);
  try {
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  } catch (e) {
    console.error('[Leads] Write error:', e.message);
  }
  console.log(`[Leads] Saved: ${JSON.stringify(lead)}`);
  return lead;
}

function getLeads() {
  return leads;
}

async function notifyOwner(lead) {
  const phoneId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!phoneId || !token) {
    console.log('[Leads] META credentials missing, skip owner notify');
    return false;
  }
  const text =
    `🔔 *New Lead - Launch Craft*\n\n` +
    `*Name:* ${lead.name || 'N/A'}\n` +
    `*Phone:* ${lead.phone || lead.waId || 'N/A'}\n` +
    `*Service:* ${lead.service || 'N/A'}\n` +
    `*Preferred time:* ${lead.preferredTime || 'N/A'}\n` +
    `*Message:* ${lead.message || 'N/A'}\n` +
    `*Source:* ${lead.source || 'chat'}\n` +
    `*Time:* ${new Date(lead.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

  try {
    const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
    const res = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to: OWNER_NUMBER,
        type: 'text',
        text: { body: text, preview_url: false },
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      }
    );
    console.log(`[Leads] Owner notified: ${res.data?.messages?.[0]?.id || 'OK'}`);
    return true;
  } catch (err) {
    console.error(`[Leads] Owner notify failed: ${err.response?.data?.error?.message || err.message}`);
    return false;
  }
}

module.exports = { saveLead, getLeads, notifyOwner, OWNER_NUMBER };
