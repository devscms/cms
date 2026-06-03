// Turns raw calendar releases into a single directional bias per (currency, time).
//
// contribution = normalizedSurprise * impactWeight * directionSign
// netScore(cluster) = Σ contribution   →   bias = bullish | bearish | neutral
//
// v1 normalization is deliberately simple (relative to |forecast|). The proper
// upgrade — once a few months of history sit in the DB — is a z-score: divide
// each surprise by the rolling std-dev of THAT indicator's past surprises, so a
// 0.2 CPI miss and a 2.6 Construction beat land on the same scale. That's the
// whole reason we store every release, not just High/Medium.

// Spread wide on purpose: a High-impact print should outweigh a Low-impact one
// even when the Low one is a bigger raw beat. This is what makes "high impact
// dominates" actually hold in the math. These are STARTING weights — tune them
// against your own strength-move correlations once history is in the DB.
const IMPACT_WEIGHT = { High: 4, Medium: 2, Low: 1, None: 0 };

// Most indicators: higher actual ⇒ stronger currency (+1).
// These are the inverse: a higher number is BAD for the currency (-1).
// Matched as case-insensitive substrings against the event title.
const INVERSE_KEYWORDS = [
  'unemployment rate',
  'unemployment change',
  'jobless',
  'initial claims',
  'continuing claims',
  'misery index',
];

function directionSign(title) {
  const t = String(title || '').toLowerCase();
  for (const kw of INVERSE_KEYWORDS) if (t.includes(kw)) return -1;
  return 1;
}

function impactWeight(impact) {
  return IMPACT_WEIGHT[impact] != null ? IMPACT_WEIGHT[impact] : 0;
}

// Surprise relative to the forecast, then SQUASHED with tanh into (-1, 1).
// The squash is the key fix: a wild beat (e.g. Construction 3.4 vs 0.8) saturates
// near +1 instead of exploding, so it can't swamp a high-impact print on raw size
// alone. Returns null when no surprise is computable (no actual or no forecast yet).
function normalizedSurprise(ev) {
  if (ev.actual == null || ev.forecast == null) return null;
  const surprise = ev.actual - ev.forecast;
  const base = Math.abs(ev.forecast) > 1e-9 ? Math.abs(ev.forecast) : 1;
  return Math.tanh(surprise / base);   // (-1, 1)
}

// Per-event contribution to its currency's bias. 0 if not yet released.
function scoreEvent(ev) {
  const ns = normalizedSurprise(ev);
  if (ns == null) return 0;
  return ns * impactWeight(ev.impact) * directionSign(ev.title);
}

function biasFromScore(netScore, eps = 0.05) {
  if (netScore > eps) return 'bullish';
  if (netScore < -eps) return 'bearish';
  return 'neutral';
}

// Collapse many events at one (currency, ts) into a single pulse-ready cluster.
function aggregateCluster(events) {
  let netScore = 0;
  let topImpact = 'None';
  const order = { None: 0, Low: 1, Medium: 2, High: 3 };
  for (const ev of events) {
    netScore += scoreEvent(ev);
    if (order[ev.impact] > order[topImpact]) topImpact = ev.impact;
  }
  netScore = Math.round(netScore * 100) / 100;
  return {
    currency: events[0].currency,
    ts: events[0].ts,
    bias: biasFromScore(netScore),
    netScore,
    topImpact,
    count: events.length,
    events: events.map(e => ({
      title: e.title, impact: e.impact, unit: e.unit,
      actual: e.actual, forecast: e.forecast, previous: e.previous,
      contribution: Math.round(scoreEvent(e) * 100) / 100,
    })),
  };
}

module.exports = {
  IMPACT_WEIGHT, directionSign, impactWeight,
  normalizedSurprise, scoreEvent, biasFromScore, aggregateCluster,
};
