/**
 * TurboQuant Vector Search Engine (Client-side ESM)
 * Corpus-IDF Count-Sketch + Fast Walsh-Hadamard Transform + 4-bit PolarQuant + 1024-bit SWAR QJL.
 * 100% offline, zero external dependencies.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'about', 'that', 'this', 'these', 'those', 'it', 'its', 'i', 'me', 'my',
  'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their',
  'can', 'could', 'would', 'should', 'shall', 'will', 'may', 'might',
  'do', 'does', 'did', 'have', 'has', 'had', 'having',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'please', 'just', 'so', 'far', 'yet', 'also', 'very', 'too', 'only',
  'some', 'any', 'all', 'every', 'both', 'each', 'other', 'such', 'than',
  'then', 'there', 'here', 'and', 'or', 'but', 'if', 'because', 'while',
  'during', 'before', 'after', 'use', 'using', 'used', 'give', 'given',
  'got', 'make', 'made', 'need', 'want', 'tell', 'let', 'know',
  'most', 'more', 'many', 'much', 'few'
]);

const NEGATIONS = new Set(['not', 'no', 'never', 'without', 'neither', 'nor']);

const MONTHS_RE = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b|\b\d{4}-\d{2}-\d{2}\b/i;
const COORDS_RE = /\b-?\d{1,2}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\b/;
const CURRENCY_RE = /\b(?:usd|eur|euro|euros|gbp|jpy|cad|aud|chf|cny|inr|dollar|dollars|yen|pound|pounds)\b/i;
const URI_GLOBAL_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^\s'"<>]+)/gi;

export function fwht(vec) {
  const n = vec.length;
  for (let h = 1; h < n; h <<= 1) {
    const step = h << 1;
    for (let i = 0; i < n; i += step) {
      for (let j = i; j < i + h; j++) {
        const x = vec[j];
        const y = vec[j + h];
        vec[j] = x + y;
        vec[j + h] = x - y;
      }
    }
  }
  const scale = 1 / Math.sqrt(n);
  for (let i = 0; i < n; i++) vec[i] *= scale;
  return vec;
}

export function lcg(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function stemWord(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('xes') || w.endsWith('ches') || w.endsWith('shes')) return w.slice(0, -2);
  if (w.endsWith('ves') && w.length > 4) return w.slice(0, -3) + 'f';
  if (w.endsWith('ing') && w.length > 5) {
    let base = w.slice(0, -3);
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2] && !'aeiou'.includes(base[base.length - 1])) {
      base = base.slice(0, -1);
    }
    return base;
  }
  if (w.endsWith('ed') && w.length > 4) {
    let base = w.slice(0, -2);
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2] && !'aeiou'.includes(base[base.length - 1])) {
      base = base.slice(0, -1);
    }
    return base;
  }
  if (w.endsWith('es') && w.length > 4 && !w.endsWith('aes') && !w.endsWith('ees') && !w.endsWith('oes')) {
    return w.slice(0, -2);
  }
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && w.length > 3) {
    let base = w.slice(0, -1);
    if (base.endsWith('e') && base.length > 3 && !base.endsWith('ee') && !base.endsWith('le')) {
      base = base.slice(0, -1);
    }
    return base;
  }
  if (w.endsWith('e') && w.length > 3 && !w.endsWith('ee') && !w.endsWith('le')) {
    return w.slice(0, -1);
  }
  return w;
}

function derivationalRoot(st) {
  if (st.length < 5) return null;
  if (st.endsWith('yer') && st.length >= 6) return st.slice(0, -3);
  if (st.endsWith('ization') && st.length >= 9) return st.slice(0, -7);
  if (st.endsWith('ation') && st.length >= 7) return st.slice(0, -5);
  if (st.endsWith('ition') && st.length >= 7) return st.slice(0, -5);
  if (st.endsWith('tion') && st.length >= 6) return st.slice(0, -3);
  if (st.endsWith('sion') && st.length >= 7) return st.slice(0, -4);
  if (st.endsWith('ment') && st.length >= 7) return st.slice(0, -4);
  if (st.endsWith('ist') && st.length >= 6) return st.slice(0, -3);
  if (st.endsWith('er') && st.length >= 5) {
    let base = st.slice(0, -2);
    if (base.length >= 3 && base[base.length - 1] === base[base.length - 2] && !'aeiou'.includes(base[base.length - 1])) {
      base = base.slice(0, -1);
    }
    return base;
  }
  return null;
}

function splitIdentifiers(str) {
  if (!str) return [];
  const expanded = String(str)
    .replace(/n['\u2019]t\b/gi, ' not')
    .replace(/['\u2019]s\b/gi, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return expanded.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function addTokenFeature(outMap, t, weight) {
  const st = stemWord(t);
  outMap.set(`w:${t}`, (outMap.get(`w:${t}`) || 0) + weight * 0.55);
  outMap.set(`s:${st}`, (outMap.get(`s:${st}`) || 0) + weight * 1.0);
  const root = derivationalRoot(st) || derivationalRoot(t);
  if (root && root.length >= 3 && root !== st) {
    const rst = stemWord(root);
    outMap.set(`s:${rst}`, (outMap.get(`s:${rst}`) || 0) + weight * 0.55);
  }
  if (t.length >= 5) {
    outMap.set(`p4:${t.slice(0, 4)}`, (outMap.get(`p4:${t.slice(0, 4)}`) || 0) + weight * 0.16);
  }
  if (t.length >= 6) {
    outMap.set(`p5:${t.slice(0, 5)}`, (outMap.get(`p5:${t.slice(0, 5)}`) || 0) + weight * 0.16);
  }
  return st;
}

function extractFeatures(text, weight = 1.0, outMap = new Map(), detectLiterals = false) {
  if (!text) return outMap;
  let workingStr = String(text);

  if (detectLiterals) {
    URI_GLOBAL_RE.lastIndex = 0;
    let match;
    let stripped = workingStr;
    while ((match = URI_GLOBAL_RE.exec(workingStr)) !== null) {
      const scheme = match[1].toLowerCase();
      const rest = match[2];
      addTokenFeature(outMap, scheme, weight * 1.4);
      if (scheme === 'http' || scheme === 'https') {
        addTokenFeature(outMap, 'url', weight * 1.1);
        addTokenFeature(outMap, 'http', weight * 0.8);
      } else {
        addTokenFeature(outMap, 'uri', weight * 0.6);
      }
      for (const sub of splitIdentifiers(rest)) {
        if (!STOPWORDS.has(sub) && !/^\d+$/.test(sub) && sub !== 'com' && sub !== 'org' && sub !== 'net') {
          addTokenFeature(outMap, sub, weight * 0.2);
        }
      }
      stripped = stripped.replace(match[0], ' ');
    }
    workingStr = stripped;

    if (MONTHS_RE.test(workingStr)) {
      addTokenFeature(outMap, 'date', weight * 0.85);
    }
    if (COORDS_RE.test(workingStr)) {
      addTokenFeature(outMap, 'coordinates', weight * 0.9);
      addTokenFeature(outMap, 'location', weight * 0.55);
    }
    if (CURRENCY_RE.test(workingStr)) {
      addTokenFeature(outMap, 'currency', weight * 0.85);
    }
  }

  const rawTokens = splitIdentifiers(workingStr);
  const activeTokens = [];

  for (let i = 0; i < rawTokens.length; i++) {
    const t = rawTokens[i];
    if (NEGATIONS.has(t)) {
      for (let j = i + 1; j <= Math.min(i + 2, rawTokens.length - 1); j++) {
        const next = rawTokens[j];
        if (!STOPWORDS.has(next) && !NEGATIONS.has(next)) {
          const st = stemWord(next);
          outMap.set(`s:un${st}`, (outMap.get(`s:un${st}`) || 0) + weight * 1.6);
          outMap.set(`w:un${next}`, (outMap.get(`w:un${next}`) || 0) + weight * 1.2);
          i = j;
          break;
        }
      }
      continue;
    }
    if (STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
    const st = addTokenFeature(outMap, t, weight);
    activeTokens.push(st);
  }

  for (let i = 0; i < activeTokens.length - 1; i++) {
    const bg = `bg:${activeTokens[i]}_${activeTokens[i + 1]}`;
    outMap.set(bg, (outMap.get(bg) || 0) + weight * 0.65);
  }

  return outMap;
}

function extractSchemaFeatures(name, tool) {
  const feats = new Map();
  const def = (tool && typeof tool === 'object' && tool.function && typeof tool.function === 'object')
    ? tool.function
    : tool;

  const effectiveName = (def && typeof def === 'object' && def.name) ? def.name : name;
  extractFeatures(effectiveName, 2.8, feats, false);

  if (typeof def === 'string') {
    extractFeatures(def, 1.5, feats, false);
    return feats;
  }
  if (!def || typeof def !== 'object') return feats;

  if (def.title) extractFeatures(def.title, 2.2, feats, false);
  if (def.domain) extractFeatures(def.domain, 1.6, feats, false);
  if (def.description) extractFeatures(def.description, 1.5, feats, false);
  if (def.criteria && def.criteria !== def.description) {
    const extraCriteria = (def.description && String(def.criteria).startsWith(String(def.description)))
      ? String(def.criteria).slice(String(def.description).length)
      : def.criteria;
    if (extraCriteria) extractFeatures(extraCriteria, 1.8, feats, false);
  }
  if (def.summary && def.summary !== def.description) extractFeatures(def.summary, 1.4, feats, false);

  const schema = def.parameters || def.inputSchema || def.input_schema || def.schema;
  const props = schema?.properties;
  if (props && typeof props === 'object') {
    for (const [pName, pSpec] of Object.entries(props)) {
      extractFeatures(pName, 1.25, feats, false);
      if (pSpec && typeof pSpec === 'object') {
        if (pSpec.description) extractFeatures(pSpec.description, 0.7, feats, false);
        if (Array.isArray(pSpec.enum)) {
          for (const val of pSpec.enum.slice(0, 20)) {
            if (typeof val === 'string') extractFeatures(val, 1.1, feats, false);
          }
        }
      }
    }
  }
  return feats;
}

function fnv1a32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export class TurboQuantEngine {
  constructor(dimOrOpts = 1024, qjlDim = 1024, seed = 42) {
    const rawDim = (dimOrOpts && typeof dimOrOpts === 'object') ? (dimOrOpts.dim || 1024) : dimOrOpts;
    const rawSeed = (dimOrOpts && typeof dimOrOpts === 'object') ? (dimOrOpts.seed ?? 42) : seed;
    let d = 64;
    while (d < rawDim) d <<= 1;
    this.dim = d;
    this.qjlDim = d;
    this.qjlWords = d >>> 5;
    this.seed = rawSeed >>> 0;

    this.signs1 = new Int8Array(d);
    this.signs2 = new Int8Array(d);
    let s = this.seed;
    const nextRng = () => {
      s = (Math.imul(1664525, s) + 1013904223) >>> 0;
      return s;
    };
    for (let i = 0; i < d; i++) this.signs1[i] = (nextRng() & 1) === 0 ? 1 : -1;
    for (let i = 0; i < d; i++) this.signs2[i] = (nextRng() & 1) === 0 ? 1 : -1;

    this.idf = new Map();
    this.defaultIdf = 1.0;
    this.toolNames = [];
    this.qMatrix = null;
    this.steps = null;
    this.resNorms = null;
    this.qjlMatrix = null;
    this.fallbackIdx = -1;

    this._scratch1 = new Float32Array(d);
    this._scratch2 = new Float32Array(d);
    this._qBits = new Uint32Array(this.qjlWords);
  }

  _embedFeatures(feats, outVec, isQuery = false) {
    outVec.fill(0);
    let matchedStems = 0;
    let totalStems = 0;
    let unseenMassSq = 0;

    for (const [feat, rawTf] of feats.entries()) {
      const isStem = feat.startsWith('s:');
      if (isStem) totalStems++;

      const knownIdf = this.idf.get(feat);
      if (knownIdf === undefined) {
        if (isQuery && isStem) {
          const wUnseen = this.defaultIdf * 0.35;
          unseenMassSq += wUnseen * wUnseen;
        }
        continue;
      }

      if (isStem) matchedStems++;
      const tf = rawTf >= 1 ? (1 + Math.log(rawTf)) : rawTf;
      const w = tf * knownIdf;
      const h1 = fnv1a32(feat, 0x811c9dc5);
      const h2 = fnv1a32(feat, 0x9e3779b9);
      outVec[h1 % this.dim] += ((h2 & 1) === 0 ? 1 : -1) * w;
    }

    let normSq = 0;
    for (let i = 0; i < this.dim; i++) normSq += outVec[i] * outVec[i];
    const damp = isQuery ? (unseenMassSq + this.defaultIdf * this.defaultIdf * 0.15) : 0;
    if (normSq > 0) {
      const inv = 1 / Math.sqrt(normSq + damp);
      for (let i = 0; i < this.dim; i++) outVec[i] *= inv;
    }
    return { matchedStems, totalStems };
  }

  fit(toolsDict) {
    const entries = toolsDict instanceof Map
      ? Array.from(toolsDict.entries())
      : Object.entries(toolsDict || {});
    const N = entries.length;
    this.toolNames = new Array(N);
    this.fallbackIdx = -1;

    if (N === 0) {
      this.idf.clear();
      this.qMatrix = new Int8Array(0);
      this.steps = new Float32Array(0);
      this.resNorms = new Float32Array(0);
      this.qjlMatrix = new Uint32Array(0);
      return;
    }

    const docFeats = new Array(N);
    const df = new Map();

    for (let i = 0; i < N; i++) {
      const [name, tool] = entries[i];
      this.toolNames[i] = name;
      if (/^(unsupported|none|no_tool|unsupported_or_none|fallback)$/i.test(name)) {
        this.fallbackIdx = i;
      }
      const feats = extractSchemaFeatures(name, tool);
      docFeats[i] = feats;
      for (const f of feats.keys()) {
        df.set(f, (df.get(f) || 0) + 1);
      }
    }

    this.idf.clear();
    for (const [f, count] of df.entries()) {
      this.idf.set(f, Math.log(1 + (N - count + 0.5) / (count + 0.5)) + 0.25);
    }
    this.defaultIdf = Math.log(1 + (N + 0.5) / 0.5) + 0.25;

    this.qMatrix = new Int8Array(N * this.dim);
    this.steps = new Float32Array(N);
    this.resNorms = new Float32Array(N);
    this.qjlMatrix = new Uint32Array(N * this.qjlWords);

    const vec = new Float32Array(this.dim);
    const residual = new Float32Array(this.dim);

    for (let idx = 0; idx < N; idx++) {
      this._embedFeatures(docFeats[idx], vec, false);
      for (let i = 0; i < this.dim; i++) vec[i] *= this.signs1[i];
      fwht(vec);

      let maxAbs = 0;
      for (let i = 0; i < this.dim; i++) {
        const a = Math.abs(vec[i]);
        if (a > maxAbs) maxAbs = a;
      }
      if (maxAbs === 0) maxAbs = 1e-6;

      const invStep = 7.0 / maxAbs;
      const step = maxAbs / 7.0;
      this.steps[idx] = step;
      const qOffset = idx * this.dim;
      let resNormSq = 0;

      for (let i = 0; i < this.dim; i++) {
        const lvl = Math.max(-7, Math.min(7, Math.round(vec[i] * invStep)));
        this.qMatrix[qOffset + i] = lvl;
        const r = vec[i] - lvl * step;
        residual[i] = r * this.signs2[i];
        resNormSq += r * r;
      }

      const resNorm = Math.sqrt(resNormSq);
      this.resNorms[idx] = resNorm;

      if (resNorm > 1e-8) {
        fwht(residual);
        const wOffset = idx * this.qjlWords;
        for (let w = 0; w < this.qjlWords; w++) {
          let bits = 0;
          const base = w << 5;
          for (let b = 0; b < 32; b++) {
            if (residual[base + b] >= 0) bits |= (1 << b);
          }
          this.qjlMatrix[wOffset + w] = bits >>> 0;
        }
      }
    }
  }

  search(query, topK = 3) {
    const N = this.toolNames.length;
    if (N === 0) return [];

    const qFeats = extractFeatures(query, 1.0, new Map(), true);
    const rotQ = this._scratch1;
    const { matchedStems, totalStems } = this._embedFeatures(qFeats, rotQ, true);

    for (let i = 0; i < this.dim; i++) rotQ[i] *= this.signs1[i];
    fwht(rotQ);

    const qjlQ = this._scratch2;
    let qNormSq = 0;
    for (let i = 0; i < this.dim; i++) {
      qNormSq += rotQ[i] * rotQ[i];
      qjlQ[i] = rotQ[i] * this.signs2[i];
    }
    const qNorm = Math.sqrt(qNormSq);
    fwht(qjlQ);

    const qBits = this._qBits;
    for (let w = 0; w < this.qjlWords; w++) {
      let bits = 0;
      const base = w << 5;
      for (let b = 0; b < 32; b++) {
        if (qjlQ[base + b] >= 0) bits |= (1 << b);
      }
      qBits[w] = bits >>> 0;
    }

    const qjlScale = (Math.PI / 2) * qNorm / this.dim;
    const results = new Array(N);

    for (let idx = 0; idx < N; idx++) {
      const qOffset = idx * this.dim;
      let iDot = 0;
      for (let i = 0; i < this.dim; i += 4) {
        iDot += rotQ[i] * this.qMatrix[qOffset + i]
              + rotQ[i + 1] * this.qMatrix[qOffset + i + 1]
              + rotQ[i + 2] * this.qMatrix[qOffset + i + 2]
              + rotQ[i + 3] * this.qMatrix[qOffset + i + 3];
      }
      let score = iDot * this.steps[idx];

      const resNorm = this.resNorms[idx];
      if (resNorm > 1e-8) {
        const wOffset = idx * this.qjlWords;
        let hamming = 0;
        for (let w = 0; w < this.qjlWords; w++) {
          hamming += popcount32(qBits[w] ^ this.qjlMatrix[wOffset + w]);
        }
        score += resNorm * qjlScale * (this.dim - 2 * hamming);
      }

      results[idx] = { name: this.toolNames[idx], score };
    }

    if (this.fallbackIdx >= 0) {
      let maxReal = -1;
      for (let i = 0; i < N; i++) {
        if (i !== this.fallbackIdx && results[i].score > maxReal) maxReal = results[i].score;
      }
      const matchRatio = totalStems > 0 ? matchedStems / totalStems : 0;
      if (matchedStems === 0 || (maxReal < 0.16 && matchRatio <= 0.34) || maxReal < 0.10) {
        results[this.fallbackIdx].score = Math.max(results[this.fallbackIdx].score, 0.32);
      }
    }

    results.sort((a, b) => b.score - a.score);
    const k = Math.min(topK, N);
    const out = new Array(k);
    for (let i = 0; i < k; i++) {
      const raw = Math.max(0, results[i].score);
      const clamped = Math.max(-12, Math.min(12, (raw - 0.21) * 13));
      const prob = 1 / (1 + Math.exp(-clamped));
      out[i] = { name: results[i].name, probability: prob, score: raw };
    }
    return out;
  }
}

export function autoSelectCandidates(candidates, options = {}) {
  if (!candidates || candidates.length === 0) return [];

  const maxK = options.maxK ?? 5;
  const minK = options.minK ?? (options.allowEmpty ? 0 : 1);
  const minScore = options.minScore ?? 0.08;
  const minProb = options.minProbability ?? options.minProb ?? 0.20;
  const relativeThreshold = options.relativeThreshold ?? 0.68;
  const cliffRatio = options.cliffRatio ?? 0.72;
  const dominantMargin = options.dominantMargin ?? 0.14;

  const top1 = candidates[0];
  const hasScore = typeof top1.score === 'number';
  const topVal = hasScore ? top1.score : top1.probability;
  const floorVal = hasScore ? minScore : minProb;

  if (topVal < floorVal) {
    return minK > 0 ? candidates.slice(0, minK) : [];
  }

  const uncertain = hasScore ? top1.score < 0.34 : top1.probability < 0.68;
  const effRel = (options.relativeThreshold !== undefined || !uncertain) ? relativeThreshold : 0.48;
  const effCliff = (options.cliffRatio !== undefined || !uncertain) ? cliffRatio : 0.58;
  const effFloor = (options.minScore !== undefined || !uncertain) ? minScore : 0.05;

  const selected = [top1];

  for (let i = 1; i < Math.min(candidates.length, maxK); i++) {
    const curr = candidates[i];
    const prev = candidates[i - 1];

    if (hasScore) {
      if (curr.score < effFloor) break;
      if (top1.score >= 0.38 && (top1.score - curr.score) > dominantMargin) break;
      if ((curr.score / Math.max(1e-6, top1.score)) < effRel) break;
      if (prev.score > 0 && (curr.score / prev.score) < effCliff) break;
    } else {
      if (curr.probability < minProb) break;
      if (top1.probability >= 0.70 && (top1.probability - curr.probability) > 0.20) break;
      if ((curr.probability / Math.max(1e-6, top1.probability)) < effRel) break;
      if (prev.probability > 0 && (curr.probability / prev.probability) < effCliff) break;
    }

    selected.push(curr);
  }

  if (selected.length < minK) {
    return candidates.slice(0, Math.min(candidates.length, minK));
  }

  return selected;
}

if (typeof window !== 'undefined') {
  window.TurboQuantEngine = TurboQuantEngine;
  window.autoSelectCandidates = autoSelectCandidates;
}
