const { Strength, CURRENCIES, TIMEFRAMES } = require('./models/Strength');

// 2 years of bars per timeframe.
const TF_CFG = {
  H1: { step: 3600e3, n: 17520 },
  H4: { step: 4 * 3600e3, n: 4380 },
  D1: { step: 24 * 3600e3, n: 730 },
};

// Bounded integer random walk in [-7, +7] — mimics real currency-strength scores.
function genTF(tf) {
  const cfg = TF_CFG[tf];
  const now = Date.now();
  const walk = {};
  for (const c of CURRENCIES) walk[c] = Math.round(Math.random() * 14 - 7);

  const docs = [];
  for (let i = cfg.n - 1; i >= 0; i--) {
    const ts = new Date(now - i * cfg.step);
    const doc = { tf, ts };
    for (const c of CURRENCIES) {
      let v = walk[c];
      const r = Math.random();
      if (r < 0.40) v += Math.random() < 0.5 ? 1 : -1;
      if (r < 0.08) v += Math.random() < 0.5 ? 2 : -2;
      if (r > 0.93) v = Math.round(v * 0.6);
      v = Math.max(-7, Math.min(7, v));
      walk[c] = v;
      doc[c] = v;
    }
    docs.push(doc);
  }
  return docs;
}

async function seedDatabase({ wipe = true } = {}) {
  if (wipe) await Strength.deleteMany({});
  let total = 0;
  for (const tf of TIMEFRAMES) {
    const docs = genTF(tf);
    await Strength.insertMany(docs, { ordered: false });
    console.log(`[seed] ${tf}: inserted ${docs.length} docs`);
    total += docs.length;
  }
  return total;
}

module.exports = { seedDatabase, genTF };
