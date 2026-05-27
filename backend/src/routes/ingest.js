const express = require('express');
const { Strength, CURRENCIES, TIMEFRAMES } = require('../models/Strength');

const router = express.Router();

// POST /api/ingest
// Header: x-ingest-token: <INGEST_TOKEN>
// Body: a single snapshot {tf, ts, USD, EUR, ...} or an array of them.
// Upserts on (tf, ts) so re-pushing the same bar is idempotent.
router.post('/ingest', async (req, res) => {
  const token = req.headers['x-ingest-token'];
  if (token !== (process.env.INGEST_TOKEN || 'dev-token')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const items = Array.isArray(req.body) ? req.body : [req.body];
  if (items.length === 0) return res.status(400).json({ error: 'empty body' });

  const ops = [];
  for (const it of items) {
    if (!it || !TIMEFRAMES.includes(it.tf)) {
      return res.status(400).json({ error: `invalid tf: ${it && it.tf}` });
    }
    const ts = new Date(it.ts);
    if (isNaN(ts.getTime())) {
      return res.status(400).json({ error: `invalid ts: ${it.ts}` });
    }
    const set = { tf: it.tf, ts };
    for (const c of CURRENCIES) set[c] = Number(it[c]) || 0;
    ops.push({
      updateOne: { filter: { tf: it.tf, ts }, update: { $set: set }, upsert: true },
    });
  }

  try {
    const r = await Strength.bulkWrite(ops, { ordered: false });
    res.json({ ok: true, received: ops.length, upserted: r.upsertedCount, modified: r.modifiedCount });
  } catch (e) {
    console.error('[ingest] error:', e.message);
    res.status(500).json({ error: 'write failed' });
  }
});

// POST /api/clear  { tf?: "H1" }  — wipe a timeframe's data (or all if tf omitted).
// Token-protected. Used by the producer before a fresh backfill.
router.post('/clear', async (req, res) => {
  const token = req.headers['x-ingest-token'];
  if (token !== (process.env.INGEST_TOKEN || 'dev-token')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const filter = {};
  if (req.body && req.body.tf) {
    if (!TIMEFRAMES.includes(req.body.tf)) return res.status(400).json({ error: `invalid tf: ${req.body.tf}` });
    filter.tf = req.body.tf;
  }
  try {
    const r = await Strength.deleteMany(filter);
    res.json({ ok: true, deleted: r.deletedCount, scope: filter.tf || 'ALL' });
  } catch (e) {
    res.status(500).json({ error: 'clear failed' });
  }
});

module.exports = router;
