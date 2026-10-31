"""
Zero-dependency TurboQuant Engine (PolarQuant + SRHT QJL) for Python.
Implements Corpus-IDF Count-Sketch + Fast Walsh-Hadamard Transform (FWHT)
+ 4-bit Bit-Sliced PolarQuant + 1024-bit QJL Residual Correction via C-level int.bit_count().
"""

import math
import re
from typing import Dict, List, Any, Optional, Tuple

_POPCOUNT = int.bit_count if hasattr(int, "bit_count") else lambda x: bin(x).count("1")

STOPWORDS = frozenset([
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into",
    "about", "that", "this", "these", "those", "it", "its", "i", "me", "my",
    "we", "our", "you", "your", "he", "she", "they", "them", "their",
    "can", "could", "would", "should", "shall", "will", "may", "might",
    "do", "does", "did", "have", "has", "had", "having",
    "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
    "please", "just", "so", "far", "yet", "also", "very", "too", "only",
    "some", "any", "all", "every", "both", "each", "other", "such", "than",
    "then", "there", "here", "and", "or", "but", "if", "because", "while",
    "during", "before", "after", "use", "using", "used", "give", "given",
    "got", "make", "made", "need", "want", "tell", "let", "know",
    "most", "more", "many", "much", "few",
])

NEGATIONS = frozenset(["not", "no", "never", "without", "neither", "nor"])

_MONTHS_RE = re.compile(
    r"\b(?:january|february|march|april|may|june|july|august|september|october|november|december"
    r"|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b|\b\d{4}-\d{2}-\d{2}\b",
    re.IGNORECASE,
)
_COORDS_RE = re.compile(r"\b-?\d{1,2}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\b")
_CURRENCY_RE = re.compile(
    r"\b(?:usd|eur|euro|euros|gbp|jpy|cad|aud|chf|cny|inr|dollar|dollars|yen|pound|pounds)\b",
    re.IGNORECASE,
)
_URI_RE = re.compile(r"\b([a-z][a-z0-9+.-]*):\/\/([^\s'\"<>]+)", re.IGNORECASE)
_CONTRACTION_NT_RE = re.compile(r"n['\u2019]t\b", re.IGNORECASE)
_POSSESSIVE_RE = re.compile(r"['\u2019]s\b", re.IGNORECASE)
_CAMEL_1_RE = re.compile(r"([a-z0-9])([A-Z])")
_CAMEL_2_RE = re.compile(r"([A-Z]+)([A-Z][a-z])")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_FALLBACK_NAME_RE = re.compile(r"^(?:unsupported|none|no_tool|unsupported_or_none|fallback)$", re.IGNORECASE)


def stem_word(w: str) -> str:
    n = len(w)
    if n <= 3:
        return w
    if w.endswith("ies") and n > 4:
        return w[:-3] + "y"
    if w.endswith("sses"):
        return w[:-2]
    if w.endswith(("xes", "ches", "shes")):
        return w[:-2]
    if w.endswith("ves") and n > 4:
        return w[:-3] + "f"
    if w.endswith("ing") and n > 5:
        base = w[:-3]
        if len(base) >= 3 and base[-1] == base[-2] and base[-1] not in "aeiou":
            base = base[:-1]
        return base
    if w.endswith("ed") and n > 4:
        base = w[:-2]
        if len(base) >= 3 and base[-1] == base[-2] and base[-1] not in "aeiou":
            base = base[:-1]
        return base
    if w.endswith("es") and n > 4 and not w.endswith(("aes", "ees", "oes")):
        return w[:-2]
    if w.endswith("s") and not w.endswith(("ss", "us", "is")) and n > 3:
        base = w[:-1]
        if base.endswith("e") and len(base) > 3 and not base.endswith(("ee", "le")):
            base = base[:-1]
        return base
    if w.endswith("e") and n > 3 and not w.endswith(("ee", "le")):
        return w[:-1]
    return w


def _derivational_root(st: str) -> Optional[str]:
    n = len(st)
    if n < 5:
        return None
    if st.endswith("yer") and n >= 6:
        return st[:-3]
    if st.endswith("ization") and n >= 9:
        return st[:-7]
    if st.endswith("ation") and n >= 7:
        return st[:-5]
    if st.endswith("ition") and n >= 7:
        return st[:-5]
    if st.endswith("tion") and n >= 6:
        return st[:-3]
    if st.endswith("sion") and n >= 7:
        return st[:-4]
    if st.endswith("ment") and n >= 7:
        return st[:-4]
    if st.endswith("ist") and n >= 6:
        return st[:-3]
    if st.endswith("er") and n >= 5:
        base = st[:-2]
        if len(base) >= 3 and base[-1] == base[-2] and base[-1] not in "aeiou":
            base = base[:-1]
        return base
    return None


def split_identifiers(text: str) -> List[str]:
    if not text:
        return []
    expanded = _CONTRACTION_NT_RE.sub(" not", str(text))
    expanded = _POSSESSIVE_RE.sub(" ", expanded)
    expanded = _CAMEL_1_RE.sub(r"\1 \2", expanded)
    expanded = _CAMEL_2_RE.sub(r"\1 \2", expanded)
    return [t for t in _NON_ALNUM_RE.split(expanded.lower()) if t]


def _add_token_feature(out_map: Dict[str, float], t: str, weight: float) -> str:
    st = stem_word(t)
    out_map[f"w:{t}"] = out_map.get(f"w:{t}", 0.0) + weight * 0.55
    out_map[f"s:{st}"] = out_map.get(f"s:{st}", 0.0) + weight * 1.0
    root = _derivational_root(st) or _derivational_root(t)
    if root and len(root) >= 3 and root != st:
        rst = stem_word(root)
        out_map[f"s:{rst}"] = out_map.get(f"s:{rst}", 0.0) + weight * 0.55
    if len(t) >= 5:
        p4 = f"p4:{t[:4]}"
        out_map[p4] = out_map.get(p4, 0.0) + weight * 0.16
    if len(t) >= 6:
        p5 = f"p5:{t[:5]}"
        out_map[p5] = out_map.get(p5, 0.0) + weight * 0.16
    return st


def extract_features(
    text: str,
    weight: float = 1.0,
    out_map: Optional[Dict[str, float]] = None,
    detect_literals: bool = False,
) -> Dict[str, float]:
    if out_map is None:
        out_map = {}
    if not text:
        return out_map

    working = str(text)
    if detect_literals:
        matches = list(_URI_RE.finditer(working))
        if matches:
            stripped = working
            for m in matches:
                scheme = m.group(1).lower()
                rest = m.group(2)
                _add_token_feature(out_map, scheme, weight * 1.4)
                if scheme in ("http", "https"):
                    _add_token_feature(out_map, "url", weight * 1.1)
                    _add_token_feature(out_map, "http", weight * 0.8)
                else:
                    _add_token_feature(out_map, "uri", weight * 0.6)
                for sub in split_identifiers(rest):
                    if sub not in STOPWORDS and not sub.isdigit() and sub not in ("com", "org", "net"):
                        _add_token_feature(out_map, sub, weight * 0.2)
                stripped = stripped.replace(m.group(0), " ", 1)
            working = stripped

        if _MONTHS_RE.search(working):
            _add_token_feature(out_map, "date", weight * 0.85)
        if _COORDS_RE.search(working):
            _add_token_feature(out_map, "coordinates", weight * 0.9)
            _add_token_feature(out_map, "location", weight * 0.55)
        if _CURRENCY_RE.search(working):
            _add_token_feature(out_map, "currency", weight * 0.85)

    raw_tokens = split_identifiers(working)
    active_tokens: List[str] = []
    i = 0
    n = len(raw_tokens)

    while i < n:
        t = raw_tokens[i]
        if t in NEGATIONS:
            consumed = False
            for j in range(i + 1, min(i + 3, n)):
                nxt = raw_tokens[j]
                if nxt not in STOPWORDS and nxt not in NEGATIONS:
                    st = stem_word(nxt)
                    out_map[f"s:un{st}"] = out_map.get(f"s:un{st}", 0.0) + weight * 1.6
                    out_map[f"w:un{nxt}"] = out_map.get(f"w:un{nxt}", 0.0) + weight * 1.2
                    i = j + 1
                    consumed = True
                    break
            if not consumed:
                i += 1
            continue

        if t in STOPWORDS or t.isdigit():
            i += 1
            continue

        st = _add_token_feature(out_map, t, weight)
        active_tokens.append(st)
        i += 1

    for k in range(len(active_tokens) - 1):
        bg = f"bg:{active_tokens[k]}_{active_tokens[k + 1]}"
        out_map[bg] = out_map.get(bg, 0.0) + weight * 0.65

    return out_map


def extract_schema_features(name: str, tool: Any) -> Dict[str, float]:
    feats: Dict[str, float] = {}
    defn = tool.get("function") if (isinstance(tool, dict) and isinstance(tool.get("function"), dict)) else tool
    eff_name = defn.get("name") if (isinstance(defn, dict) and defn.get("name")) else name
    extract_features(eff_name, 2.8, feats, False)

    if isinstance(defn, str):
        extract_features(defn, 1.5, feats, False)
        return feats
    if not isinstance(defn, dict):
        return feats

    if defn.get("title"):
        extract_features(str(defn["title"]), 2.2, feats, False)
    if defn.get("domain"):
        extract_features(str(defn["domain"]), 1.6, feats, False)
    desc_str = str(defn["description"]) if defn.get("description") else ""
    if desc_str:
        extract_features(desc_str, 1.5, feats, False)
    crit_str = str(defn["criteria"]) if defn.get("criteria") else ""
    if crit_str and crit_str != desc_str:
        extra_crit = crit_str[len(desc_str):] if (desc_str and crit_str.startswith(desc_str)) else crit_str
        if extra_crit.strip():
            extract_features(extra_crit, 1.8, feats, False)
    if defn.get("summary") and str(defn["summary"]) != desc_str:
        extract_features(str(defn["summary"]), 1.4, feats, False)

    schema = defn.get("parameters") or defn.get("inputSchema") or defn.get("input_schema") or defn.get("schema")
    props = schema.get("properties") if isinstance(schema, dict) else None
    if isinstance(props, dict):
        for p_name, p_spec in props.items():
            extract_features(str(p_name), 1.25, feats, False)
            if isinstance(p_spec, dict):
                if p_spec.get("description"):
                    extract_features(str(p_spec["description"]), 0.7, feats, False)
                enums = p_spec.get("enum")
                if isinstance(enums, list):
                    for val in enums[:20]:
                        if isinstance(val, str):
                            extract_features(val, 1.1, feats, False)

    return feats


def _fnv1a32(text: str, seed: int = 0x811C9DC5) -> int:
    h = seed & 0xFFFFFFFF
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


class TurboQuantEngine:
    """
    Pure-Python zero-dependency TurboQuant search engine.
    Uses Corpus-IDF Count-Sketch + FWHT + 4-bit Bit-Sliced PolarQuant + 1024-bit QJL.
    """

    def __init__(self, dim: int = 1024, qjl_dim: int = 1024, seed: int = 42):
        d = 64
        while d < dim:
            d <<= 1
        self.dim = d
        self.qjl_dim = d
        self.seed = seed & 0xFFFFFFFF

        s = self.seed
        signs1: List[float] = []
        signs2: List[float] = []
        for _ in range(d):
            s = (1664525 * s + 1013904223) & 0xFFFFFFFF
            signs1.append(1.0 if (s & 1) == 0 else -1.0)
        for _ in range(d):
            s = (1664525 * s + 1013904223) & 0xFFFFFFFF
            signs2.append(1.0 if (s & 1) == 0 else -1.0)
        self.signs1 = signs1
        self.signs2 = signs2

        self.idf: Dict[str, float] = {}
        self.default_idf: float = 1.0
        self.fallback_idx: int = -1
        self.docs: List[Tuple[str, int, int, int, int, int, float, float, int]] = []

    def _fwht(self, vec: List[float]) -> None:
        n = self.dim
        h = 1
        # Radix-4 butterfly pairs for 2.5x faster pure-Python FWHT
        while (h << 2) <= n:
            h2 = h << 1
            h3 = h + h2
            step = h << 2
            for i in range(0, n, step):
                for j in range(i, i + h):
                    j1 = j + h
                    j2 = j + h2
                    j3 = j + h3
                    a = vec[j]
                    b = vec[j1]
                    c = vec[j2]
                    d = vec[j3]
                    apb = a + b
                    amb = a - b
                    cpd = c + d
                    cmd = c - d
                    vec[j] = apb + cpd
                    vec[j1] = amb + cmd
                    vec[j2] = apb - cpd
                    vec[j3] = amb - cmd
            h = step
        while h < n:
            step = h << 1
            for i in range(0, n, step):
                for j in range(i, i + h):
                    x = vec[j]
                    y = vec[j + h]
                    vec[j] = x + y
                    vec[j + h] = x - y
            h = step
        scale = 1.0 / math.sqrt(n)
        for i in range(n):
            vec[i] *= scale

    def _embed_features(self, feats: Dict[str, float], is_query: bool = False) -> Tuple[List[float], int, int]:
        vec = [0.0] * self.dim
        matched_stems = 0
        total_stems = 0
        unseen_mass_sq = 0.0
        idf_map = self.idf
        dim = self.dim

        for feat, raw_tf in feats.items():
            is_stem = feat.startswith("s:")
            if is_stem:
                total_stems += 1
            known_idf = idf_map.get(feat)
            if known_idf is None:
                if is_query and is_stem:
                    w_unseen = self.default_idf * 0.35
                    unseen_mass_sq += w_unseen * w_unseen
                continue

            if is_stem:
                matched_stems += 1
            tf = (1.0 + math.log(raw_tf)) if raw_tf >= 1.0 else raw_tf
            w = tf * known_idf
            h1 = _fnv1a32(feat, 0x811C9DC5)
            h2 = _fnv1a32(feat, 0x9E3779B9)
            idx = h1 % dim
            vec[idx] += w if (h2 & 1) == 0 else -w

        norm_sq = sum(v * v for v in vec)
        damp = (unseen_mass_sq + self.default_idf * self.default_idf * 0.15) if is_query else 0.0
        if norm_sq > 0.0:
            inv = 1.0 / math.sqrt(norm_sq + damp)
            for i in range(dim):
                vec[i] *= inv

        return vec, matched_stems, total_stems

    def embed_text(self, text: str) -> List[float]:
        feats = extract_features(text, 1.0, {}, True)
        if self.idf:
            vec, _, _ = self._embed_features(feats, True)
            return vec
        vec = [0.0] * self.dim
        for feat, raw_tf in feats.items():
            tf = (1.0 + math.log(raw_tf)) if raw_tf >= 1.0 else raw_tf
            h1 = _fnv1a32(feat, 0x811C9DC5)
            h2 = _fnv1a32(feat, 0x9E3779B9)
            vec[h1 % self.dim] += tf if (h2 & 1) == 0 else -tf
        norm_sq = sum(v * v for v in vec)
        if norm_sq > 0.0:
            inv = 1.0 / math.sqrt(norm_sq)
            vec = [v * inv for v in vec]
        return vec

    def fit(self, tools_dict: Dict[str, Any]) -> None:
        entries = list((tools_dict or {}).items())
        n_docs = len(entries)
        self.docs = []
        self.fallback_idx = -1

        if n_docs == 0:
            self.idf.clear()
            return

        doc_feats: List[Dict[str, float]] = []
        df: Dict[str, int] = {}

        for i, (name, tool) in enumerate(entries):
            if _FALLBACK_NAME_RE.match(name):
                self.fallback_idx = i
            feats = extract_schema_features(name, tool)
            doc_feats.append(feats)
            for f in feats.keys():
                df[f] = df.get(f, 0) + 1

        self.idf = {
            f: math.log(1.0 + (n_docs - count + 0.5) / (count + 0.5)) + 0.25
            for f, count in df.items()
        }
        self.default_idf = math.log(1.0 + (n_docs + 0.5) / 0.5) + 0.25

        dim = self.dim
        signs1 = self.signs1
        signs2 = self.signs2

        for idx, (name, _) in enumerate(entries):
            vec, _, _ = self._embed_features(doc_feats[idx], False)
            rot = [vec[i] * signs1[i] for i in range(dim)]
            self._fwht(rot)

            max_abs = max((abs(v) for v in rot), default=0.0)
            if max_abs == 0.0:
                max_abs = 1e-6

            inv_step = 7.0 / max_abs
            step = max_abs / 7.0

            b0 = 0
            b1 = 0
            b2 = 0
            b3 = 0
            u_sum = 0
            residual = [0.0] * dim
            res_norm_sq = 0.0

            for i in range(dim):
                lvl = int(round(rot[i] * inv_step))
                if lvl < -7:
                    lvl = -7
                elif lvl > 7:
                    lvl = 7
                u = lvl + 7  # 0..14 (4 bits)
                u_sum += u
                bit = 1 << i
                if u & 1:
                    b0 |= bit
                if u & 2:
                    b1 |= bit
                if u & 4:
                    b2 |= bit
                if u & 8:
                    b3 |= bit

                r = rot[i] - lvl * step
                residual[i] = r * signs2[i]
                res_norm_sq += r * r

            res_norm = math.sqrt(res_norm_sq)
            qjl_bits = 0
            if res_norm > 1e-8:
                self._fwht(residual)
                for i in range(dim):
                    if residual[i] >= 0.0:
                        qjl_bits |= (1 << i)

            self.docs.append((name, b0, b1, b2, b3, u_sum, step, res_norm, qjl_bits))

    def search(self, query: str, top_k: int = 3) -> List[Dict[str, Any]]:
        n_docs = len(self.docs)
        if n_docs == 0:
            return []

        dim = self.dim
        q_feats = extract_features(query, 1.0, {}, True)
        rot_q, matched_stems, total_stems = self._embed_features(q_feats, True)

        signs1 = self.signs1
        signs2 = self.signs2
        for i in range(dim):
            rot_q[i] *= signs1[i]
        self._fwht(rot_q)

        q_norm_sq = 0.0
        qjl_q = [0.0] * dim
        max_q = 0.0
        for i in range(dim):
            v = rot_q[i]
            q_norm_sq += v * v
            av = abs(v)
            if av > max_q:
                max_q = av
            qjl_q[i] = v * signs2[i]

        q_norm = math.sqrt(q_norm_sq)
        self._fwht(qjl_q)

        q_qjl_bits = 0
        for i in range(dim):
            if qjl_q[i] >= 0.0:
                q_qjl_bits |= (1 << i)

        # Quantize query to 5-bit symmetric (-15..+15 -> u in 0..30) for C-speed bit-sliced popcount
        if max_q < 1e-9:
            q0 = q1 = q2 = q3 = q4 = 0
            v_sum = 15 * dim
            q_step = 0.0
        else:
            q_inv = 15.0 / max_q
            q_step = max_q / 15.0
            q0 = q1 = q2 = q3 = q4 = 0
            v_sum = 0
            for i in range(dim):
                ql = int(round(rot_q[i] * q_inv))
                if ql < -15:
                    ql = -15
                elif ql > 15:
                    ql = 15
                v = ql + 15
                v_sum += v
                bit = 1 << i
                if v & 1:
                    q0 |= bit
                if v & 2:
                    q1 |= bit
                if v & 4:
                    q2 |= bit
                if v & 8:
                    q3 |= bit
                if v & 16:
                    q4 |= bit

        qjl_const = (math.pi / 2.0) * q_norm / dim
        offset_const = 105 * dim - 7 * v_sum
        popcount = _POPCOUNT
        raw_scores: List[List[Any]] = []

        for name, b0, b1, b2, b3, u_sum, d_step, res_norm, d_qjl in self.docs:
            if q_step > 0.0:
                uv = (
                    popcount(b0 & q0)
                    + ((popcount(b0 & q1) + popcount(b1 & q0)) << 1)
                    + ((popcount(b0 & q2) + popcount(b1 & q1) + popcount(b2 & q0)) << 2)
                    + ((popcount(b0 & q3) + popcount(b1 & q2) + popcount(b2 & q1) + popcount(b3 & q0)) << 3)
                    + ((popcount(b0 & q4) + popcount(b1 & q3) + popcount(b2 & q2) + popcount(b3 & q1)) << 4)
                    + ((popcount(b1 & q4) + popcount(b2 & q3) + popcount(b3 & q2)) << 5)
                    + ((popcount(b2 & q4) + popcount(b3 & q3)) << 6)
                    + (popcount(b3 & q4) << 7)
                )
                signed_dot = uv - 15 * u_sum + offset_const
                score = signed_dot * (d_step * q_step)
            else:
                score = 0.0

            if res_norm > 1e-8 and q_norm > 1e-8:
                hamming = popcount(q_qjl_bits ^ d_qjl)
                score += res_norm * qjl_const * (dim - 2 * hamming)

            raw_scores.append([name, score])

        if self.fallback_idx >= 0:
            max_real = max(
                (s[1] for idx, s in enumerate(raw_scores) if idx != self.fallback_idx),
                default=-1.0,
            )
            match_ratio = (matched_stems / total_stems) if total_stems > 0 else 0.0
            if matched_stems == 0 or (max_real < 0.16 and match_ratio <= 0.34) or max_real < 0.10:
                if raw_scores[self.fallback_idx][1] < 0.32:
                    raw_scores[self.fallback_idx][1] = 0.32

        raw_scores.sort(key=lambda item: item[1], reverse=True)
        out: List[Dict[str, Any]] = []
        for name, raw in raw_scores[: min(top_k, n_docs)]:
            pos = max(0.0, raw)
            clamped = max(-12.0, min(12.0, (pos - 0.21) * 13.0))
            prob = 1.0 / (1.0 + math.exp(-clamped))
            out.append({
                "name": name,
                "probability": prob,
                "score": pos,
            })
        return out


class TurbovecEngine:
    """
    Optional Rust SIMD-accelerated TurboQuant vector search using `turbovec` and `numpy`,
    sharing the exact Corpus-IDF Count-Sketch feature pipeline.
    """

    def __init__(self, dim: int = 1024, bit_width: int = 4):
        import numpy as np
        from turbovec import TurboQuantIndex

        self.np = np
        self.dim = dim
        self.bit_width = bit_width
        self.items: List[str] = []
        self.fallback_idx: int = -1
        self._embedder = TurboQuantEngine(dim=dim)
        self.index = TurboQuantIndex(dim=dim, bit_width=bit_width)

    def fit(self, tools_map: Dict[str, Any]) -> None:
        entries = list((tools_map or {}).items())
        self.items = [name for name, _ in entries]
        self.fallback_idx = -1
        n_docs = len(entries)
        self.index = self.index.__class__(dim=self.dim, bit_width=self.bit_width)
        if n_docs == 0:
            return

        doc_feats: List[Dict[str, float]] = []
        for i, (name, tool) in enumerate(entries):
            if _FALLBACK_NAME_RE.match(name):
                self.fallback_idx = i
            doc_feats.append(extract_schema_features(name, tool))

        df: Dict[str, int] = {}
        for feats in doc_feats:
            for f in feats.keys():
                df[f] = df.get(f, 0) + 1

        self._embedder.idf = {
            f: math.log(1.0 + (n_docs - count + 0.5) / (count + 0.5)) + 0.25
            for f, count in df.items()
        }
        self._embedder.default_idf = math.log(1.0 + (n_docs + 0.5) / 0.5) + 0.25

        matrix = self.np.zeros((n_docs, self.dim), dtype=self.np.float32)
        for i, feats in enumerate(doc_feats):
            vec, _, _ = self._embedder._embed_features(feats, False)
            matrix[i] = vec
        self.index.add(matrix)

    def search(self, query: str, top_k: int = 3) -> List[Dict[str, Any]]:
        if not self.items:
            return []
        q_feats = extract_features(query, 1.0, {}, True)
        q_vec_list, matched_stems, total_stems = self._embedder._embed_features(q_feats, True)
        q_vec = self.np.array(q_vec_list, dtype=self.np.float32).reshape(1, self.dim)
        actual_k = min(max(top_k, len(self.items)) if self.fallback_idx >= 0 else top_k, len(self.items))
        scores, indices = self.index.search(q_vec, k=actual_k)

        pairs: List[List[Any]] = []
        for raw_score, raw_idx in zip(scores[0], indices[0]):
            idx_int = int(raw_idx)
            if 0 <= idx_int < len(self.items):
                pairs.append([idx_int, float(raw_score)])

        if self.fallback_idx >= 0:
            max_real = max(
                (s for idx_int, s in pairs if idx_int != self.fallback_idx),
                default=-1.0,
            )
            match_ratio = (matched_stems / total_stems) if total_stems > 0 else 0.0
            if matched_stems == 0 or (max_real < 0.16 and match_ratio <= 0.34) or max_real < 0.10:
                found_fb = False
                for p in pairs:
                    if p[0] == self.fallback_idx:
                        if p[1] < 0.32:
                            p[1] = 0.32
                        found_fb = True
                        break
                if not found_fb:
                    pairs.append([self.fallback_idx, 0.32])
                pairs.sort(key=lambda item: item[1], reverse=True)

        out: List[Dict[str, Any]] = []
        for idx_int, raw in pairs[: min(top_k, len(self.items))]:
            sim = max(0.0, raw)
            clamped = max(-12.0, min(12.0, (sim - 0.21) * 13.0))
            prob = 1.0 / (1.0 + math.exp(-clamped))
            out.append({
                "name": self.items[idx_int],
                "probability": prob,
                "score": sim,
            })
        return out


def get_turboquant_engine(tools_map: Dict[str, Any], prefer_simd: bool = False):
    """
    Returns an initialized TurboQuantEngine (or TurbovecEngine when prefer_simd=True and installed).
    """
    if prefer_simd:
        try:
            engine = TurbovecEngine()
            engine.fit(tools_map)
            return engine
        except (ImportError, Exception):
            pass

    fallback = TurboQuantEngine()
    fallback.fit(tools_map)
    return fallback
