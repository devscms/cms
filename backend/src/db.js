const mongoose = require('mongoose');
const dns = require('dns');

// mongodb+srv:// needs a DNS SRV lookup. Some ISP/local resolvers refuse it
// (querySrv ECONNREFUSED). Force public resolvers for reliability.
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (_) {}

// Connect to MONGODB_URI if set (production: Atlas).
// Otherwise spin up an in-memory MongoDB for zero-config local dev.
async function connectDB() {
  let uri = process.env.MONGODB_URI;
  let memServer = null;

  if (!uri) {
    // FAIL FAST in production — do NOT silently fall back to in-memory Mongo
    // (mongod binary often crashes on shared hosting, exhausts process limits).
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MONGODB_URI is required in production. Set it as an env variable.');
    }
    let MongoMemoryServer;
    try {
      ({ MongoMemoryServer } = require('mongodb-memory-server'));
    } catch (e) {
      throw new Error(
        'No MONGODB_URI set and mongodb-memory-server is not installed.\n' +
        'Either set MONGODB_URI (Atlas) in .env, or run: npm install'
      );
    }
    console.log('[db] No MONGODB_URI — starting in-memory MongoDB (dev mode, data is not persisted)...');
    memServer = await MongoMemoryServer.create();
    uri = memServer.getUri();
  }

  await mongoose.connect(uri, { dbName: 'csm', serverSelectionTimeoutMS: 15000 });
  console.log('[db] connected:', uri.replace(/\/\/[^@]*@/, '//***@'));
  return { uri, memServer };
}

module.exports = { connectDB };
