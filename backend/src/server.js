const path = require('path');
const fs = require('fs');

// Load .env if present (Node >= 20.6). Harmless if the file is absent.
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (_) {}

const express = require('express');
const cors = require('cors');
const { connectDB } = require('./db');
const { Strength } = require('./models/Strength');
const { seedDatabase } = require('./seedData');
const strengthRoutes = require('./routes/strength');
const ingestRoutes = require('./routes/ingest');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.use('/api', strengthRoutes);
app.use('/api', ingestRoutes);

// Serve the frontend — try several layouts so the app works whether deployed as
// CurrencyStrengthApp/backend (../../mock) or with backend contents at the app root (../mock).
// MOCK_DIR env var overrides everything.
function resolveMockDir() {
  if (process.env.MOCK_DIR) return process.env.MOCK_DIR;
  const candidates = [
    path.join(__dirname, '..', 'mock'),         // flat layout (backend contents at app root)
    path.join(__dirname, '..', '..', 'mock'),   // CurrencyStrengthApp/backend layout
    path.join(__dirname, '..', 'public'),       // Passenger convention
  ];
  return candidates.find(p => fs.existsSync(path.join(p, 'index.html')));
}
const mockDir = resolveMockDir();
if (mockDir) {
  app.use('/', express.static(mockDir));
  // Dedicated calendar page — support both spellings
  app.get(['/calendar', '/calender'], (req, res) => res.sendFile(path.join(mockDir, 'calendar.html')));
  console.log('[server] serving frontend from:', mockDir);
} else {
  console.warn('[server] WARN: frontend folder not found — only /api routes will work');
}

const PORT = process.env.PORT || 4000;
const isProd = process.env.NODE_ENV === 'production';

connectDB()
  .then(async () => {
    // Auto-seed is a dev convenience only. In production, the MT5 producer fills the DB.
    if (isProd) {
      const count = await Strength.estimatedDocumentCount();
      console.log(`[server] production — DB has ${count} snapshots (no auto-seed)`);
      return;
    }
    const count = await Strength.estimatedDocumentCount();
    if (count === 0) {
      console.log('[server] empty DB — seeding sample data (dev)...');
      await seedDatabase({ wipe: false });
    } else {
      console.log(`[server] DB has ${count} snapshots`);
    }
  })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] listening on port ${PORT} (NODE_ENV=${process.env.NODE_ENV || 'dev'})`);
    });
  })
  .catch((e) => {
    console.error('[server] failed to start:', e.message);
    process.exit(1);
  });
