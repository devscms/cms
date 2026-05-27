// Standalone seeder — useful against a persistent DB (Atlas / local Mongo).
// For the in-memory dev DB, the server auto-seeds on startup instead
// (a separate process gets its own in-memory instance).
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (_) {}

const mongoose = require('mongoose');
const { connectDB } = require('./db');
const { seedDatabase } = require('./seedData');

(async () => {
  if (!process.env.MONGODB_URI) {
    console.warn('[seed] WARNING: no MONGODB_URI set. Seeding an in-memory DB that dies with this process is pointless.');
    console.warn('[seed] Set MONGODB_URI to seed a persistent DB, or just run `npm start` (server auto-seeds in dev).');
  }
  await connectDB();
  const total = await seedDatabase({ wipe: true });
  console.log(`[seed] done — ${total} docs total`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('[seed] failed:', e); process.exit(1); });
