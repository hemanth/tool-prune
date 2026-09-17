// Fast Walsh-Hadamard Transform (FWHT) in O(d log d)
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

// Deterministic PRNG (LCG)
function lcg(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export class TurboQuantSearch {
  constructor(dim = 256, qjlDim = 64, seed = 1337) {
    this.dim = dim;
    this.qjlDim = qjlDim;
    const rng = lcg(seed);

    // Diagonal Rademacher matrix (+1 or -1)
    this.rademacher = new Float64Array(dim);
    for (let i = 0; i < dim; i++) {
      this.rademacher[i] = rng() < 0.5 ? -1 : 1;
    }

    // QJL random projection matrix (qjlDim x dim)
    this.qjlMatrix = new Array(qjlDim);
    for (let i = 0; i < qjlDim; i++) {
      const row = new Float64Array(dim);
      for (let j = 0; j < dim; j++) {
        row[j] = (rng() < 0.5 ? -1 : 1) / Math.sqrt(qjlDim);
      }
      this.qjlMatrix[i] = row;
    }

    this.tools = [];
    this.quantizedIndex = [];
  }

  // Feature hashing: maps tokens and char n-grams to d-dimensional sphere
  embedText(text) {
    const vec = new Float64Array(this.dim);
    const clean = text.toLowerCase();
    const tokens = clean.replace(/[^a-z0-9_]/g, ' ').split(/\s+/).filter(Boolean);

    // Unigrams and bigrams
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      this._hashFeature(t, 2.0, vec);
      if (i < tokens.length - 1) {
        this._hashFeature(`${t}_${tokens[i + 1]}`, 1.5, vec);
      }
      // Subword character trigrams
      if (t.length >= 3) {
        for (let j = 0; j <= t.length - 3; j++) {
          this._hashFeature(t.slice(j, j + 3), 0.5, vec);
        }
      }
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += vec[i] * vec[i];
    if (norm > 0) {
      norm = Math.sqrt(norm);
      for (let i = 0; i < this.dim; i++) vec[i] /= norm;
    }
    return vec;
  }

  _hashFeature(feat, weight, vec) {
    let h1 = 0x811c9dc5;
    for (let i = 0; i < feat.length; i++) {
      h1 ^= feat.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193);
    }
    const idx = Math.abs(h1) % this.dim;
    const sign = (h1 & 0x10000) ? 1 : -1;
    vec[idx] += sign * weight;
  }

  // Quantize vector using Random Rotation + 2-bit PolarQuant + 1-bit QJL residual
  quantize(vec) {
    const rotated = new Float64Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      rotated[i] = vec[i] * this.rademacher[i];
    }
    fwht(rotated);

    // 2-bit PolarQuant: 4 intervals [-inf, -0.67], [-0.67, 0], [0, 0.67], [0.67, inf]
    // Scaled by 1 / sqrt(dim)
    const std = 1.0 / Math.sqrt(this.dim);
    const qLevels = new Float64Array([-1.18 * std, -0.38 * std, 0.38 * std, 1.18 * std]);
    const codes = new Uint8Array(this.dim);
    const dequant = new Float64Array(this.dim);
    const residual = new Float64Array(this.dim);

    for (let i = 0; i < this.dim; i++) {
      const val = rotated[i];
      let code = 0;
      if (val < -0.67 * std) code = 0;
      else if (val < 0) code = 1;
      else if (val < 0.67 * std) code = 2;
      else code = 3;

      codes[i] = code;
      dequant[i] = qLevels[code];
      residual[i] = val - dequant[i];
    }

    // QJL: 1-bit sign transform of residual
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

    return { codes, dequant, resNorm, qjlSigns };
  }

  index(toolsMap) {
    this.tools = Object.keys(toolsMap);
    this.quantizedIndex = this.tools.map(name => {
      const tool = toolsMap[name];
      const text = `${name} ${tool.description || ''} ${tool.criteria || ''}`;
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

    // Project query with QJL matrix for residual dot product
    const qQjl = new Float64Array(this.qjlDim);
    for (let i = 0; i < this.qjlDim; i++) {
      let dot = 0;
      const row = this.qjlMatrix[i];
      for (let j = 0; j < this.dim; j++) dot += row[j] * qRotated[j];
      qQjl[i] = dot;
    }

    const scores = this.quantizedIndex.map(item => {
      // 1. Dot product with dequantized base
      let dotBase = 0;
      for (let i = 0; i < this.dim; i++) {
        dotBase += qRotated[i] * item.dequant[i];
      }

      // 2. QJL 1-bit residual correction
      let qjlCorrection = 0;
      for (let i = 0; i < this.qjlDim; i++) {
        qjlCorrection += qQjl[i] * item.qjlSigns[i];
      }
      const residualEst = Math.sqrt(Math.PI / 2) * (item.resNorm / Math.sqrt(this.qjlDim)) * qjlCorrection;

      const score = dotBase + residualEst;
      return { name: item.name, score };
    });

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  }
}
