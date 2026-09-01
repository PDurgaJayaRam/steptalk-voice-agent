const fs = require('fs');
const path = require('path');
const axios = require('axios');

const LEADS_FILE = path.join(__dirname, 'leads.json');
const OWNER_NUMBER = '918790406516'; // +91 8790406516

// ---- Persistence: Postgres if DATABASE_URL set, else file (ephemeral) ----
// On Render, add a Postgres (free tier) and set DATABASE_URL — leads then survive redeploys.
// Without DATABASE_URL, uses leads.json (works locally, but ephemeral on Render free).
let usePostgres = false;
let pgPool = null;
let leads = []; // in-memory fallback / cache

async function initPostgres() {
  if (!process.env.DATABASE_URL) return;
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false,
    });
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        name TEXT,
        phone TEXT,
        wa_id TEXT,
        service TEXT,
        preferred_time TEXT,
        message TEXT,
        profile_name TEXT,
        source TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    usePostgres = true;
    console.log('[Leads] Postgres enabled — persistent storage');
    // Load count for log
    const r = await pgPool.query('SELECT COUNT(*) FROM leads');
    console.log(`[Leads] Postgres leads count: ${r.rows[0].count}`);
  } catch (e) {
    console.error('[Leads] Postgres init failed, falling back to file:', e.message);
    usePostgres = false;
    pgPool = null;
  }
}

// Init file fallback immediately (sync)
try {
  if (fs.existsSync(LEADS_FILE)) {
    leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
    console.log(`[Leads] Loaded ${leads.length} leads from file`);
  }
} catch (e) {
  console.log('[Leads] No existing leads file, starting fresh');
  leads = [];
}

// Async Postgres init (fire and forget, but expose promise for callers)
const pgReady = initPostgres();

async function saveLead(lead) {
  lead.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  lead.createdAt = new Date().toISOString();

  if (usePostgres && pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO leads (id, name, phone, wa_id, service, preferred_time, message, profile_name, source, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [lead.id, lead.name || null, lead.phone || null, lead.waId || null, lead.service || null, lead.preferredTime || null, lead.message || null, lead.profileName || null, lead.source || null, lead.createdAt]
      );
      console.log(`[Leads] Saved to Postgres: ${lead.id}`);
      return lead;
    } catch (e) {
      console.error('[Leads] Postgres save failed, fallback to file:', e.message);
    }
  }

  // File fallback
  leads.push(lead);
  try {
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  } catch (e) {
    console.error('[Leads] Write error:', e.message);
  }
  console.log(`[Leads] Saved to file: ${JSON.stringify(lead)}`);
  return lead;
}

async function getLeads() {
  if (usePostgres && pgPool) {
    try {
      const r = await pgPool.query('SELECT id, name, phone, wa_id as "waId", service, preferred_time as "preferredTime", message, profile_name as "profileName", source, created_at as "createdAt" FROM leads ORDER BY created_at DESC LIMIT 500');
      return r.rows;
    } catch (e) {
      console.error('[Leads] Postgres get failed:', e.message);
    }
  }
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

module.exports = { saveLead, getLeads, notifyOwner, OWNER_NUMBER, pgReady };
