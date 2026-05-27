const express = require('express');
const { Strength, CURRENCIES, TIMEFRAMES } = require('../models/Strength');

const router = express.Router();

function parseTime(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  const d = new Date(isNaN(n) ? v : n);
  return isNaN(d.getTime()) ? null : d;
}

// GET /api/strength?tf=D1&from=...&to=...&cur=USD,EUR&limit=5000
// Returns [{ ts, USD, EUR, ... }] sorted by ts ascending.
router.get('/strength', async (req, res) => {
  const tf = (req.query.tf || 'D1').toUpperCase();
  if (!TIMEFRAMES.includes(tf)) return res.status(400).json({ error: `invalid tf: ${tf}` });

  const q = { tf };
  const from = parseTime(req.query.from);
  const to = parseTime(req.query.to);
  if (from || to) {
    q.ts = {};
    if (from) q.ts.$gte = from;
    if (to) q.ts.$lte = to;
  }

  // Optional currency projection
  let wanted = CURRENCIES;
  if (req.query.cur) {
    const req_cur = String(req.query.cur).toUpperCase().split(',').map(s => s.trim());
    wanted = CURRENCIES.filter(c => req_cur.includes(c));
    if (wanted.length === 0) return res.status(400).json({ error: 'no valid currencies in cur' });
  }
  const projection = { _id: 0, ts: 1 };
  for (const c of wanted) projection[c] = 1;

  const limit = Math.min(Number(req.query.limit) || 50000, 200000);
  try {
    const docs = await Strength.find(q, projection).sort({ ts: 1 }).limit(limit).lean();
    res.json({ tf, count: docs.length, currencies: wanted, data: docs });
  } catch (e) {
    console.error('[strength] error:', e.message);
    res.status(500).json({ error: 'query failed' });
  }
});

// GET /api/strength/latest?tf=D1[&n=N]
//   default: single doc (backward compat)
//   with n=N (1..10): { count, data:[newest,...] } — useful for "live + last closed" panels
router.get('/strength/latest', async (req, res) => {
  const tf = (req.query.tf || 'D1').toUpperCase();
  if (!TIMEFRAMES.includes(tf)) return res.status(400).json({ error: `invalid tf: ${tf}` });
  const nRaw = req.query.n;
  const n = Math.max(1, Math.min(Number(nRaw) || 1, 10));
  try {
    const docs = await Strength.find({ tf }, { _id: 0 }).sort({ ts: -1 }).limit(n).lean();
    if (nRaw != null) return res.json({ count: docs.length, data: docs });
    res.json(docs[0] || null);
  } catch (e) {
    res.status(500).json({ error: 'query failed' });
  }
});

module.exports = router;
