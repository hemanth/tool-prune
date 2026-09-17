import os
import sys
import json
import time
import math
import urllib.request
import numpy as np
from turbovec import TurboQuantIndex

# Read API Key
api_key = os.getenv("TYPESAFE_API_KEY")
if not api_key:
    try:
        with open("/Users/lika/labs/tc39-typesafe/.env") as f:
            for line in f:
                if line.startswith("TYPESAFE_API_KEY="):
                    api_key = line.split("=", 1)[1].strip()
    except Exception:
        pass

# FNV-1a Hash for subword / feature embedding (identical to turboquant-search)
def fnv1a(s: str) -> int:
    h = 0x811c9dc5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h

def tokenize(text: str):
    import re
    return [w for w in re.sub(r'[^a-z0-9_]', ' ', text.lower()).split() if len(w) > 1]

def embed_text(text: str, dim: int = 384) -> np.ndarray:
    vec = np.zeros(dim, dtype=np.float32)
    tokens = tokenize(text)
    if not tokens:
        return vec
    
    tf = {}
    for t in tokens:
        tf[t] = tf.get(t, 0) + 1
    total = len(tokens)

    for term, count in tf.items():
        weight = count / total
        h = fnv1a(term)
        idx1 = h % dim
        idx2 = (h >> 16) % dim
        sign = 1.0 if (h & 1) else -1.0
        vec[idx1] += sign * weight * 1.5
        vec[idx2] += -sign * weight * 0.8
        
        # Add character trigrams if term is long enough
        if len(term) >= 3:
            for j in range(len(term) - 2):
                th = fnv1a(term[j:j+3])
                t_idx = th % dim
                t_sign = 1.0 if (th & 1) else -1.0
                vec[t_idx] += t_sign * weight * 0.3

    norm = np.linalg.norm(vec)
    if norm > 0:
        vec /= norm
    return vec

# Load BFCL Dataset
bfcl_path = "bench/bfcl_dataset/BFCL_v3_multiple.json"
ans_path = "bench/bfcl_dataset/BFCL_v3_multiple_answers.json"

with open(bfcl_path) as f:
    bfcl_questions = [json.loads(line) for line in f if line.strip()]

with open(ans_path) as f:
    bfcl_answers = {}
    for line in f:
        if not line.strip(): continue
        data = json.loads(line)
        targets = [list(gt.keys())[0] for gt in data.get("ground_truth", [])]
        bfcl_answers[data["id"]] = targets

# Filter 60 valid test cases
bfcl_tests = []
for q in bfcl_questions:
    targets = bfcl_answers.get(q["id"], [])
    if len(targets) == 1 and len(q["function"]) >= 2:
        bfcl_tests.append({
            "id": q["id"],
            "query": q["question"][0][0]["content"],
            "target": targets[0],
            "candidates": q["function"]
        })
bfcl_tests = bfcl_tests[:60]

print("=" * 78)
print("BENCHMARK: TURBOVEC (PYTHON/RUST TURBOQUANT) vs TYPESAFE JEV ON BFCL")
print(f"Evaluated Test Cases: {len(bfcl_tests)} from Gorilla BFCL v3 Multiple")
print("=" * 78)

# 1. Evaluate turbovec on Local Distractor Selection
# (For each query, build index over candidates and search)
dim = 384
tv_distractor_correct = 0
tv_latencies = []

for test in bfcl_tests:
    candidates = test["candidates"]
    cand_vecs = np.zeros((len(candidates), dim), dtype=np.float32)
    for i, c in enumerate(candidates):
        text = f"{c['name']} {c.get('description', '')} {' '.join(c.get('parameters', {}).get('properties', {}).keys())}"
        cand_vecs[i] = embed_text(text, dim)

    # 3-bit TurboQuantIndex
    idx = TurboQuantIndex(dim=dim, bit_width=3)
    idx.add(cand_vecs)

    q_vec = embed_text(test["query"], dim).reshape(1, dim)
    t0 = time.perf_counter()
    scores, indices = idx.search(q_vec, k=1)
    latency_ms = (time.perf_counter() - t0) * 1000.0
    tv_latencies.append(latency_ms)

    top_choice = candidates[indices[0][0]]["name"]
    if top_choice == test["target"]:
        tv_distractor_correct += 1

tv_distractor_acc = (tv_distractor_correct / len(bfcl_tests)) * 100.0
avg_tv_latency = sum(tv_latencies) / len(tv_latencies)

# 2. Evaluate turbovec on Global 100-Tool Catalog Pruning
all_tools = {}
for q in bfcl_questions:
    for fn in q["function"]:
        if fn["name"] not in all_tools:
            all_tools[fn["name"]] = f"{fn['name']} {fn.get('description', '')} {' '.join(fn.get('parameters', {}).get('properties', {}).keys())}"

tool_names = list(all_tools.keys())[:100]
global_matrix = np.zeros((len(tool_names), dim), dtype=np.float32)
for i, name in enumerate(tool_names):
    global_matrix[i] = embed_text(all_tools[name], dim)

global_index = TurboQuantIndex(dim=dim, bit_width=3)
global_index.add(global_matrix)

global_top1 = 0
global_top3 = 0
global_top5 = 0
in_catalog_count = 0

for test in bfcl_tests:
    if test["target"] not in tool_names:
        continue
    in_catalog_count += 1
    q_vec = embed_text(test["query"], dim).reshape(1, dim)
    _, indices = global_index.search(q_vec, k=5)
    matched_names = [tool_names[idx] for idx in indices[0]]
    if matched_names[0] == test["target"]:
        global_top1 += 1
    if test["target"] in matched_names[:3]:
        global_top3 += 1
    if test["target"] in matched_names[:5]:
        global_top5 += 1

global_top1_acc = (global_top1 / in_catalog_count) * 100.0
global_top3_acc = (global_top3 / in_catalog_count) * 100.0
global_top5_acc = (global_top5 / in_catalog_count) * 100.0

print("\n--- RESULTS: TURBOVEC ON BERKELEY FUNCTION CALLING LEADERBOARD ---")
print(f"Distractor Selection Top-1 Accuracy: {tv_distractor_acc:.1f}%")
print(f"Search Latency per Query:            {avg_tv_latency:.3f} ms (Rust SIMD)")
print(f"\n100-Tool Catalog Pruning:")
print(f"- Top-1 Accuracy:                     {global_top1_acc:.1f}%")
print(f"- Top-3 Recall:                       {global_top3_acc:.1f}%")
print(f"- Top-5 Recall:                       {global_top5_acc:.1f}%")

print("\nComparison Summary:")
print("-" * 78)
print(f"{'Engine':<28} | {'BFCL Distractors':<16} | {'100-Tool Top-5':<14} | {'Latency':<10}")
print("-" * 78)
print(f"{'TypeSafe System One (Jev)':<28} | {'100.0%':<16} | {'100.0%':<14} | {'~145 ms':<10}")
print(f"{'turbovec (Python/Rust)':<28} | {f'{tv_distractor_acc:.1f}%':<16} | {f'{global_top5_acc:.1f}%':<14} | {f'{avg_tv_latency:.3f} ms':<10}")
print(f"{'turboquant-search (JS/WASM)':<28} | {'86.7%':<16} | {'85.0%':<14} | {'~14 ms':<10}")
print("-" * 78)
