const mongoose = require('mongoose');

// The 8 currencies the chart draws. Events for OTHER currencies (CNY, etc.) are
// still stored — we just don't pulse them by default. Keeping the full record is
// what makes historical correlation analysis possible later.
const CURRENCIES = ['USD', 'EUR', 'CHF', 'CAD', 'NZD', 'JPY', 'AUD', 'GBP'];
const IMPACTS    = ['High', 'Medium', 'Low', 'None'];

const schema = new mongoose.Schema({
  // Where this row came from: 'mt5' | 'forexfactory' | 'jblanked'. Lets us keep
  // multiple sources side by side without them clobbering each other.
  source:   { type: String, required: true },
  // Stable id from the source (MT5: the MqlCalendarValue.id; FF: its event id).
  // (source, eventId) is the dedupe key — re-ingesting the same release just
  // updates it (e.g. filling in `actual` after the number prints).
  eventId:  { type: String, required: true },

  ts:       { type: Date,   required: true },   // release time (same clock as Strength.ts)
  currency: { type: String, required: true },   // not enum-restricted on purpose — store everything
  title:    { type: String, required: true },   // e.g. "CPI m/m"
  impact:   { type: String, enum: IMPACTS, default: 'None' },

  // Raw numbers, kept as-is so any score can be re-derived later. null = not released yet.
  actual:   { type: Number, default: null },
  forecast: { type: Number, default: null },
  previous: { type: Number, default: null },
  unit:     { type: String, default: '' },      // '%', 'K', etc. (display only)
}, { versionKey: false, timestamps: true });

// Idempotent upserts dedupe on (source, eventId).
schema.index({ source: 1, eventId: 1 }, { unique: true });
// Main query path: a time window, optionally filtered by currency.
schema.index({ ts: 1, currency: 1 });

const Event = mongoose.model('Event', schema);

module.exports = { Event, CURRENCIES, IMPACTS };
