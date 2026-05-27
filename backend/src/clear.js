// Wipe stored snapshots. Usage:
//   node src/clear.js          → clear ALL
//   node src/clear.js D1       → clear one timeframe
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (_) {}

const mongoose = require('mongoose');
const { connectDB } = require('./db');
const { Strength, TIMEFRAMES } = require('./models/Strength');

(async () => {
  const tf = process.argv[2];
  const filter = {};
  if (tf) {
    if (!TIMEFRAMES.includes(tf)) { console.error(`invalid tf: ${tf}`); process.exit(1); }
    filter.tf = tf;
  }
  await connectDB();
  const r = await Strength.deleteMany(filter);
  console.log(`[clear] deleted ${r.deletedCount} docs (scope: ${tf || 'ALL'})`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('[clear] failed:', e); process.exit(1); });
