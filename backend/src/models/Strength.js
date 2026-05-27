const mongoose = require('mongoose');

const CURRENCIES = ['USD', 'EUR', 'CHF', 'CAD', 'NZD', 'JPY', 'AUD', 'GBP'];
const TIMEFRAMES = ['H1', 'H4', 'D1'];

const fields = {
  tf: { type: String, required: true, enum: TIMEFRAMES },
  ts: { type: Date, required: true },
};
for (const c of CURRENCIES) fields[c] = { type: Number, default: 0 };

const schema = new mongoose.Schema(fields, { versionKey: false });
// One snapshot per (timeframe, timestamp). Upserts dedupe on this.
schema.index({ tf: 1, ts: 1 }, { unique: true });

const Strength = mongoose.model('Strength', schema);

module.exports = { Strength, CURRENCIES, TIMEFRAMES };
