const express = require('express');
const { Event } = require('../models/Event');
const { aggregateCluster } = require('../lib/scoring');

const router = express.Router();

function parseTime(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  const d = new Date(isNaN(n) ? v : n);
  return isNaN(d.getTime()) ? null : d;
}

// GET /api/events?from=&to=&cur=USD,EUR&impact=High,Medium&grouped=true
//
// DB stores EVERYTHING (all impacts, all currencies). Filtering happens here, at
// read time — that's why `impact` and `cur` are query params, not ingest rules.
//
//   grouped=true (default): one cluster per (currency, ts) with net bias → pulses
//   grouped=false:          flat list of raw events
router.get('/events', async (req, res) => {
  const q = {};

  const from = parseTime(req.query.from);
  const to = parseTime(req.query.to);
  if (from || to) {
    q.ts = {};
    if (from) q.ts.$gte = from;
    if (to) q.ts.$lte = to;
  }

  if (req.query.cur) {
    const cur = String(req.query.cur).toUpperCase().split(',').map(s => s.trim()).filter(Boolean);
    if (cur.length) q.currency = { $in: cur };
  }

  // Default view = the market movers. Pass impact=High,Medium,Low,None to widen.
  const impact = (req.query.impact != null)
    ? String(req.query.impact).split(',').map(s => s.trim()).filter(Boolean)
    : ['High', 'Medium'];
  if (impact.length) q.impact = { $in: impact };

  const limit = Math.min(Number(req.query.limit) || 20000, 100000);
  const grouped = req.query.grouped !== 'false' && req.query.grouped !== '0';

  try {
    const docs = await Event.find(q, { _id: 0 }).sort({ ts: 1 }).limit(limit).lean();
    if (!grouped) return res.json({ count: docs.length, data: docs });

    // Group by (currency, ts) → one pulse-ready cluster each.
    const buckets = new Map();
    for (const d of docs) {
      const key = `${d.currency}|${new Date(d.ts).getTime()}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(d);
    }
    const clusters = [...buckets.values()]
      .map(aggregateCluster)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));
    res.json({ count: clusters.length, data: clusters });
  } catch (e) {
    console.error('[events] query error:', e.message);
    res.status(500).json({ error: 'query failed' });
  }
});

// POST /api/events/ingest
// Header: x-ingest-token: <INGEST_TOKEN>
// Body: a single event or an array. Upserts on (source, eventId) so re-pushing
// the same release (e.g. to fill in `actual` after it prints) is idempotent.
router.post('/events/ingest', async (req, res) => {
  const token = req.headers['x-ingest-token'];
  if (token !== (process.env.INGEST_TOKEN || 'dev-token')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const items = Array.isArray(req.body) ? req.body : [req.body];
  if (items.length === 0) return res.status(400).json({ error: 'empty body' });

  const ops = [];
  for (const it of items) {
    if (!it || it.source == null || it.eventId == null) {
      return res.status(400).json({ error: 'each event needs source and eventId' });
    }
    const ts = new Date(it.ts);
    if (isNaN(ts.getTime())) return res.status(400).json({ error: `invalid ts: ${it.ts}` });

    const num = v => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)))
      ? null : Number(v);

    const set = {
      source: String(it.source),
      eventId: String(it.eventId),
      ts,
      currency: String(it.currency || '').toUpperCase(),
      title: String(it.title || ''),
      impact: ['High', 'Medium', 'Low', 'None'].includes(it.impact) ? it.impact : 'None',
      actual: num(it.actual),
      forecast: num(it.forecast),
      previous: num(it.previous),
      unit: String(it.unit || ''),
    };
    ops.push({
      updateOne: {
        filter: { source: set.source, eventId: set.eventId },
        update: { $set: set },
        upsert: true,
      },
    });
  }

  try {
    const r = await Event.bulkWrite(ops, { ordered: false });
    res.json({ ok: true, received: ops.length, upserted: r.upsertedCount, modified: r.modifiedCount });
  } catch (e) {
    console.error('[events ingest] error:', e.message);
    res.status(500).json({ error: 'write failed' });
  }
});

// POST /api/events/clear  { source?: "mt5" } — token-protected wipe (rarely needed).
router.post('/events/clear', async (req, res) => {
  const token = req.headers['x-ingest-token'];
  if (token !== (process.env.INGEST_TOKEN || 'dev-token')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const filter = {};
  if (req.body && req.body.source) filter.source = String(req.body.source);
  try {
    const r = await Event.deleteMany(filter);
    res.json({ ok: true, deleted: r.deletedCount, scope: filter.source || 'ALL' });
  } catch (e) {
    res.status(500).json({ error: 'clear failed' });
  }
});

module.exports = router;
