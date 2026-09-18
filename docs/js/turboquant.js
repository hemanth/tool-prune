/**
 * TurboQuant Vector Search Engine (Client-side ESM / UMD)
 * Data-oblivious quantization via Fast Walsh-Hadamard Transform + PolarQuant + QJL residual.
 * 100% offline, zero external dependencies.
 */

export function fwht(vec) {
  const d = vec.length;
  let h = 1;
  while (h < d) {
    for (let i = 0; i < d; i += 2 * h) {
      for (let j = i; j < i + h; j++) {
        const x = vec[j];
        const y = vec[j + h];
        vec[j] = x + y;
        vec[j + h] = x - y;
      }
    }
    h *= 2;
  }
  const scale = 1 / Math.sqrt(d);
  for (let i = 0; i < d; i++) vec[i] *= scale;
  return vec;
}

export function lcg(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export class TurboQuantEngine {
  constructor(options = {}) {
    this.dim = options.dim || 256;
    this.qjlDim = options.qjlDim || 64;
    const rng = lcg(options.seed || 1337);

    // Diagonal Rademacher matrix (+1 or -1)
    this.rademacher = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      this.rademacher[i] = rng() < 0.5 ? -1 : 1;
    }

    // QJL random projection matrix
    this.qjlMatrix = new Array(this.qjlDim);
    for (let i = 0; i < this.qjlDim; i++) {
      const row = new Float64Array(this.dim);
      for (let j = 0; j < this.dim; j++) {
        row[j] = (rng() < 0.5 ? -1 : 1) / Math.sqrt(this.qjlDim);
      }
      this.qjlMatrix[i] = row;
    }

    this.items = [];
    this.index = [];
  }

  embedText(text) {
    const vec = new Float64Array(this.dim);
    const clean = text.toLowerCase();
    const tokens = clean.replace(/[^a-z0-9_]/g, ' ').split(/\s+/).filter(t => t.length > 1);

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      this._hashFeature(t, 2.0, vec);
      if (i < tokens.length - 1) {
        this._hashFeature(`${t}_${tokens[i + 1]}`, 1.5, vec);
      }
      if (t.length >= 3) {
        for (let j = 0; j <= t.length - 3; j++) {
          this._hashFeature(t.slice(j, j + 3), 0.5, vec);
        }
      }
    }

    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += vec[i] * vec[i];
    if (norm > 0) {
      norm = Math.sqrt(norm);
      for (let i = 0; i < this.dim; i++) vec[i] /= norm;
    }
    return vec;
  }

  _hashFeature(feat, weight, vec) {
    let h = 0x811c9dc5;
    for (let i = 0; i < feat.length; i++) {
      h ^= feat.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const idx = Math.abs(h) % this.dim;
    const sign = (h & 1) ? 1 : -1;
    vec[idx] += sign * weight;
  }

  quantize(vec) {
    const rotated = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      rotated[i] = vec[i] * this.rademacher[i];
    }
    fwht(rotated);

    const std = 1.0 / Math.sqrt(this.dim);
    const qLevels = new Float64Array([-1.18 * std, -0.38 * std, 0.38 * std, 1.18 * std]);
    const dequant = new Float64Array(this.dim);
    const residual = new Float64Array(this.dim);

    for (let i = 0; i < this.dim; i++) {
      const val = rotated[i];
      let code = 0;
      if (val < -0.67 * std) code = 0;
      else if (val < 0) code = 1;
      else if (val < 0.67 * std) code = 2;
      else code = 3;

      dequant[i] = qLevels[code];
      residual[i] = val - dequant[i];
    }

    let resNorm = 0;
    for (let i = 0; i < this.dim; i++) resNorm += residual[i] * residual[i];
    resNorm = Math.sqrt(resNorm);

    const qjlSigns = new Int8Array(this.qjlDim);
    for (let i = 0; i < this.qjlDim; i++) {
      let dot = 0;
      const row = this.qjlMatrix[i];
      for (let j = 0; j < this.dim; j++) dot += row[j] * residual[j];
      qjlSigns[i] = dot >= 0 ? 1 : -1;
    }

    return { dequant, resNorm, qjlSigns };
  }

  fit(toolsMap) {
    this.items = Object.keys(toolsMap);
    this.index = this.items.map(name => {
      const tool = toolsMap[name];
      const text = typeof tool === 'string'
        ? `${name} ${tool}`
        : `${name} ${tool.description || ''} ${tool.criteria || ''} ${Object.keys(tool.parameters?.properties || {}).join(' ')}`;
      const emb = this.embedText(text);
      return {
        name,
        ...this.quantize(emb)
      };
    });
  }

  search(query, topK = 3) {
    const qEmb = this.embedText(query);
    const qRotated = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      qRotated[i] = qEmb[i] * this.rademacher[i];
    }
    fwht(qRotated);

    const qQjl = new Float64Array(this.qjlDim);
    for (let i = 0; i < this.qjlDim; i++) {
      let dot = 0;
      const row = this.qjlMatrix[i];
      for (let j = 0; j < this.dim; j++) dot += row[j] * qRotated[j];
      qQjl[i] = dot;
    }

    const scores = this.index.map(item => {
      let dotBase = 0;
      for (let i = 0; i < this.dim; i++) dotBase += qRotated[i] * item.dequant[i];

      let qjlCorrection = 0;
      for (let i = 0; i < this.qjlDim; i++) qjlCorrection += qQjl[i] * item.qjlSigns[i];

      const residualEst = Math.sqrt(Math.PI / 2) * (item.resNorm / Math.sqrt(this.qjlDim)) * qjlCorrection;
      const rawScore = dotBase + residualEst;
      // Map to calibrated [0, 1] probability range
      const prob = 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, rawScore * 5))));
      return { name: item.name, probability: prob, score: rawScore };
    });

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  }
}

/**
 * Automatically select the most relevant tool candidates based on score distribution,
 * cliff / elbow drop-off, and relevance floors.
 */
export function autoSelectCandidates(candidates, options = {}) {
  if (!candidates || candidates.length === 0) return [];

  const maxK = options.maxK ?? 5;
  const minK = options.minK ?? (options.allowEmpty ? 0 : 1);
  const minScore = options.minScore ?? 0.12;
  const minProb = options.minProbability ?? options.minProb ?? 0.20;
  const relativeThreshold = options.relativeThreshold ?? 0.70;
  const cliffRatio = options.cliffRatio ?? 0.75;
  const dominantMargin = options.dominantMargin ?? 0.14;

  const top1 = candidates[0];
  const hasScore = typeof top1.score === 'number';
  const topVal = hasScore ? top1.score : top1.probability;
  const floorVal = hasScore ? minScore : minProb;

  if (topVal < floorVal) {
    return minK > 0 ? candidates.slice(0, minK) : [];
  }

  const selected = [top1];

  for (let i = 1; i < Math.min(candidates.length, maxK); i++) {
    const curr = candidates[i];
    const prev = candidates[i - 1];

    if (hasScore) {
      if (curr.score < minScore) break;
      // Dominant lead: top1 is strong and clearly ahead
      if (top1.score >= 0.35 && (top1.score - curr.score) > dominantMargin) break;
      // Relative to top1
      if ((curr.score / Math.max(1e-6, top1.score)) < relativeThreshold) break;
      // Cliff drop from previous
      if (prev.score > 0 && (curr.score / prev.score) < cliffRatio) break;
    } else {
      if (curr.probability < minProb) break;
      if (top1.probability >= 0.70 && (top1.probability - curr.probability) > 0.20) break;
      if ((curr.probability / Math.max(1e-6, top1.probability)) < relativeThreshold) break;
      if (prev.probability > 0 && (curr.probability / prev.probability) < cliffRatio) break;
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

