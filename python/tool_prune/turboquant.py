import math
import re
from typing import Any, Dict, List, Optional

def _fwht(vec: List[float]) -> List[float]:
    """Fast Walsh-Hadamard Transform in O(d log d)."""
    d = len(vec)
    h = 1
    while h < d:
        for i in range(0, d, 2 * h):
            for j in range(i, i + h):
                x = vec[j]
                y = vec[j + h]
                vec[j] = x + y
                vec[j + h] = x - y
        h *= 2
    scale = 1.0 / math.sqrt(d)
    for i in range(d):
        vec[i] *= scale
    return vec

def _lcg(seed: int = 42):
    s = seed
    def rng() -> float:
        nonlocal s
        s = (s * 1664525 + 1013904223) & 0xFFFFFFFF
        return s / 4294967296.0
    return rng

class TurboQuantEngine:
    """
    Zero-dependency TurboQuant vector search engine.
    Uses randomized rotation (Rademacher + FWHT) + PolarQuant 2-bit scalar quantization
    + QJL 1-bit residual correction.
    """
    def __init__(self, dim: int = 256, qjl_dim: int = 64, seed: int = 1337):
        self.dim = dim
        self.qjl_dim = qjl_dim
        rng = _lcg(seed)

        # Diagonal Rademacher matrix (+1 or -1)
        self.rademacher = [-1.0 if rng() < 0.5 else 1.0 for _ in range(dim)]

        # QJL random projection matrix
        scale = 1.0 / math.sqrt(qjl_dim)
        self.qjl_matrix: List[List[float]] = []
        for _ in range(qjl_dim):
            row = [(-1.0 if rng() < 0.5 else 1.0) * scale for _ in range(dim)]
            self.qjl_matrix.append(row)

        self.items: List[str] = []
        self.index: List[Dict[str, Any]] = []

    def _hash_feature(self, feat: str, weight: float, vec: List[float]):
        h = 0x811c9dc5
        for ch in feat:
            h ^= ord(ch)
            h = (h * 0x01000193) & 0xFFFFFFFF
        idx = h % self.dim
        sign = 1.0 if (h & 1) else -1.0
        vec[idx] += sign * weight

    def embed_text(self, text: str) -> List[float]:
        vec = [0.0] * self.dim
        clean = text.lower()
        tokens = [t for t in re.sub(r'[^a-z0-9_]', ' ', clean).split() if len(t) > 1]

        for i, t in enumerate(tokens):
            self._hash_feature(t, 2.0, vec)
            if i < len(tokens) - 1:
                self._hash_feature(f"{t}_{tokens[i + 1]}", 1.5, vec)
            if len(t) >= 3:
                for j in range(len(t) - 2):
                    self._hash_feature(t[j:j + 3], 0.5, vec)

        norm = math.sqrt(sum(v * v for v in vec))
        if norm > 0:
            vec = [v / norm for v in vec]
        return vec

    def quantize(self, vec: List[float]) -> Dict[str, Any]:
        rotated = [vec[i] * self.rademacher[i] for i in range(self.dim)]
        _fwht(rotated)

        std = 1.0 / math.sqrt(self.dim)
        q_levels = [-1.18 * std, -0.38 * std, 0.38 * std, 1.18 * std]
        dequant = [0.0] * self.dim
        residual = [0.0] * self.dim

        for i in range(self.dim):
            val = rotated[i]
            if val < -0.67 * std:
                code = 0
            elif val < 0.0:
                code = 1
            elif val < 0.67 * std:
                code = 2
            else:
                code = 3

            dequant[i] = q_levels[code]
            residual[i] = val - dequant[i]

        res_norm = math.sqrt(sum(r * r for r in residual))

        qjl_signs = [0] * self.qjl_dim
        for i in range(self.qjl_dim):
            dot = sum(self.qjl_matrix[i][j] * residual[j] for j in range(self.dim))
            qjl_signs[i] = 1 if dot >= 0 else -1

        return {
            "dequant": dequant,
            "res_norm": res_norm,
            "qjl_signs": qjl_signs,
        }

    def fit(self, tools_map: Dict[str, Any]):
        self.items = list(tools_map.keys())
        self.index = []
        for name in self.items:
            tool = tools_map[name]
            if isinstance(tool, str):
                text = f"{name} {tool}"
            elif isinstance(tool, dict):
                props = " ".join(tool.get("parameters", {}).get("properties", {}).keys())
                text = f"{name} {tool.get('description', '')} {tool.get('criteria', '')} {props}"
            else:
                text = name

            emb = self.embed_text(text)
            q = self.quantize(emb)
            self.index.append({
                "name": name,
                **q
            })

    def search(self, query: str, top_k: int = 3) -> List[Dict[str, Any]]:
        q_emb = self.embed_text(query)
        q_rotated = [q_emb[i] * self.rademacher[i] for i in range(self.dim)]
        _fwht(q_rotated)

        q_qjl = [
            sum(self.qjl_matrix[i][j] * q_rotated[j] for j in range(self.dim))
            for i in range(self.qjl_dim)
        ]

        scores = []
        qjl_scale = math.sqrt(math.pi / 2.0) / math.sqrt(self.qjl_dim)

        for item in self.index:
            dot_base = sum(q_rotated[i] * item["dequant"][i] for i in range(self.dim))
            qjl_correction = sum(q_qjl[i] * item["qjl_signs"][i] for i in range(self.qjl_dim))
            residual_est = qjl_scale * item["res_norm"] * qjl_correction
            raw_score = dot_base + residual_est

            clamped = max(-10.0, min(10.0, raw_score * 5.0))
            prob = 1.0 / (1.0 + math.exp(-clamped))
            scores.append({
                "name": item["name"],
                "probability": prob,
                "score": raw_score
            })

        scores.sort(key=lambda s: s["score"], reverse=True)
        return scores[:top_k]

class TurbovecEngine:
    """
    SIMD-accelerated TurboQuant vector search using `turbovec` (Rust) and `numpy`.
    """
    def __init__(self, dim: int = 384, bit_width: int = 3):
        import numpy as np
        from turbovec import TurboQuantIndex
        self.np = np
        self.dim = dim
        self.bit_width = bit_width
        self.items: List[str] = []
        self.index = TurboQuantIndex(dim=dim, bit_width=bit_width)

    def _embed_text(self, text: str) -> Any:
        vec = self.np.zeros(self.dim, dtype=self.np.float32)
        clean = text.lower()
        tokens = [t for t in re.sub(r'[^a-z0-9_]', ' ', clean).split() if len(t) > 1]
        if not tokens:
            return vec

        tf: Dict[str, int] = {}
        for t in tokens:
            tf[t] = tf.get(t, 0) + 1
        total = len(tokens)

        for term, count in tf.items():
            weight = count / total
            h = 0x811c9dc5
            for ch in term:
                h ^= ord(ch)
                h = (h * 0x01000193) & 0xFFFFFFFF
            idx1 = h % self.dim
            idx2 = (h >> 16) % self.dim
            sign = 1.0 if (h & 1) else -1.0
            vec[idx1] += sign * weight * 1.5
            vec[idx2] += -sign * weight * 0.8

            if len(term) >= 3:
                for j in range(len(term) - 2):
                    th = 0x811c9dc5
                    for ch in term[j:j + 3]:
                        th ^= ord(ch)
                        th = (th * 0x01000193) & 0xFFFFFFFF
                    t_idx = th % self.dim
                    t_sign = 1.0 if (th & 1) else -1.0
                    vec[t_idx] += t_sign * weight * 0.3

        norm = self.np.linalg.norm(vec)
        if norm > 0:
            vec /= norm
        return vec

    def fit(self, tools_map: Dict[str, Any]):
        self.items = list(tools_map.keys())
        matrix = self.np.zeros((len(self.items), self.dim), dtype=self.np.float32)
        for i, name in enumerate(self.items):
            tool = tools_map[name]
            if isinstance(tool, str):
                text = f"{name} {tool}"
            elif isinstance(tool, dict):
                props = " ".join(tool.get("parameters", {}).get("properties", {}).keys())
                text = f"{name} {tool.get('description', '')} {tool.get('criteria', '')} {props}"
            else:
                text = name
            matrix[i] = self._embed_text(text)

        self.index.add(matrix)

    def search(self, query: str, top_k: int = 3) -> List[Dict[str, Any]]:
        q_vec = self._embed_text(query).reshape(1, self.dim)
        scores, indices = self.index.search(q_vec, k=min(top_k, len(self.items)))
        results = []
        for score, idx in zip(scores[0], indices[0]):
            name = self.items[idx]
            clamped = max(-10.0, min(10.0, float(score) * 5.0))
            prob = 1.0 / (1.0 + math.exp(-clamped))
            results.append({
                "name": name,
                "probability": prob,
                "score": float(score)
            })
        return results

def get_turboquant_engine(tools_map: Dict[str, Any]):
    """
    Returns a fitted TurboQuant engine.
    Uses `TurbovecEngine` (Rust SIMD) if `turbovec` is installed,
    otherwise falls back to zero-dependency `TurboQuantEngine`.
    """
    try:
        engine = TurbovecEngine()
        engine.fit(tools_map)
        return engine
    except Exception:
        engine = TurboQuantEngine()
        engine.fit(tools_map)
        return engine
