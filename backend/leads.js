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
        created_at TIMESTAMPTZ DEFAULT NOW(),
        urgency TEXT,
        budget_mentioned TEXT,
        sentiment TEXT,
        needs_human BOOLEAN,
        objections TEXT,
        summary TEXT,
        outcome TEXT
      );
    `);
    // Add columns if table existed before (idempotent)
    await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS urgency TEXT`);
    await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS budget_mentioned TEXT`);
    await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS sentiment TEXT`);
    await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS needs_human BOOLEAN`);
    await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS objections TEXT`);
    await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS summary TEXT`);
    await pgPool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS outcome TEXT`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS call_outcomes (
        id TEXT PRIMARY KEY,
        wa_id TEXT,
        outcome TEXT,
        duration_secs INTEGER,
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
        `INSERT INTO leads (id, name, phone, wa_id, service, preferred_time, message, profile_name, source, created_at, urgency, budget_mentioned, sentiment, needs_human, objections, summary, outcome)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [lead.id, lead.name || null, lead.phone || null, lead.waId || null, lead.service || null, lead.preferredTime || null, lead.message || null, lead.profileName || null, lead.source || null, lead.createdAt, lead.urgency || null, lead.budget_mentioned || null, lead.sentiment || null, lead.needs_human || false, lead.objections ? JSON.stringify(lead.objections) : null, lead.summary || null, lead.outcome || 'lead_captured']
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
      const r = await pgPool.query('SELECT id, name, phone, wa_id as "waId", service, preferred_time as "preferredTime", message, profile_name as "profileName", source, created_at as "createdAt", urgency, budget_mentioned as "budgetMentioned", sentiment, needs_human as "needsHuman", objections, summary, outcome FROM leads ORDER BY created_at DESC LIMIT 500');
      return r.rows.map(row => {
        if (row.objections) { try { row.objections = JSON.parse(row.objections); } catch {} }
        return row;
      });
    } catch (e) {
      console.error('[Leads] Postgres get failed:', e.message);
    }
  }
  return leads;
}

async function logCallOutcome({ waId, outcome, durationSecs }) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (usePostgres && pgPool) {
    try {
      await pgPool.query(`INSERT INTO call_outcomes (id, wa_id, outcome, duration_secs) VALUES ($1,$2,$3,$4)`, [id, waId || null, outcome, durationSecs || null]);
      console.log(`[Leads] Call outcome logged: ${outcome} waId=${waId}`);
      return;
    } catch (e) {
      console.error('[Leads] Call outcome log failed:', e.message);
    }
  }
  console.log(`[Leads] Call outcome (file mode, not persisted): ${outcome} waId=${waId}`);
}

async function getCallOutcomes() {
  if (usePostgres && pgPool) {
    try {
      const r = await pgPool.query(`SELECT * FROM call_outcomes ORDER BY created_at DESC LIMIT 200`);
      return r.rows;
    } catch {}
  }
  return [];
}

// Structured extraction + summary (free, reuses NVIDIA endpoint via ai.js)
async function enrichLead(lead) {
  try {
    const { generateLLMResponse } = require('./ai');
    const prompt = `Extract structured JSON for this lead. Lead: name=${lead.name}, service=${lead.service}, message="${(lead.message || '').slice(0, 300)}", preferredTime=${lead.preferredTime}. Return ONLY valid JSON with keys: urgency (low/medium/high), budget_mentioned (string or null), sentiment (positive/neutral/negative), needs_human (boolean), objections (array of strings), summary (2 sentences). No markdown.`;
    const raw = await generateLLMResponse(prompt);
    const jsonStr = (raw.match(/\{[\s\S]*\}/) || [])[0];
    if (!jsonStr) return lead;
    const parsed = JSON.parse(jsonStr);
    lead.urgency = parsed.urgency || 'low';
    lead.budget_mentioned = parsed.budget_mentioned || null;
    lead.sentiment = parsed.sentiment || 'neutral';
    lead.needs_human = !!parsed.needs_human;
    lead.objections = Array.isArray(parsed.objections) ? parsed.objections : [];
    lead.summary = parsed.summary || null;
    lead.outcome = lead.needs_human ? 'needs_human' : 'lead_captured';
    // Update row if postgres
    if (usePostgres && pgPool) {
      await pgPool.query(`UPDATE leads SET urgency=$1, budget_mentioned=$2, sentiment=$3, needs_human=$4, objections=$5, summary=$6, outcome=$7 WHERE id=$8`, [lead.urgency, lead.budget_mentioned, lead.sentiment, lead.needs_human, JSON.stringify(lead.objections), lead.summary, lead.outcome, lead.id]);
      console.log(`[Leads] Enriched ${lead.id}: urgency=${lead.urgency} needs_human=${lead.needs_human}`);
    }
    return lead;
  } catch (e) {
    console.log(`[Leads] Enrich failed: ${e.message}`);
    return lead;
  }
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

module.exports = { saveLead, getLeads, notifyOwner, OWNER_NUMBER, pgReady, logCallOutcome, getCallOutcomes, enrichLead };
