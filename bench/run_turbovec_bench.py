import os
import sys
import json
import time

# Import directly from local tool_prune package
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT_DIR, "python"))

from tool_prune.turboquant import TurboQuantEngine, TurbovecEngine, extract_features

try:
    import turbovec  # noqa: F401
    import numpy as np
    _HAS_TURBOVEC = True
except ImportError:
    _HAS_TURBOVEC = False

bfcl_path = os.path.join(ROOT_DIR, "bench/bfcl_dataset/BFCL_v3_multiple.json")
ans_path = os.path.join(ROOT_DIR, "bench/bfcl_dataset/BFCL_v3_multiple_answers.json")

with open(bfcl_path, encoding="utf-8") as f:
    bfcl_questions = [json.loads(line) for line in f if line.strip()]

with open(ans_path, encoding="utf-8") as f:
    bfcl_answers = {}
    for line in f:
        if not line.strip():
            continue
        data = json.loads(line)
        targets = [list(gt.keys())[0] for gt in data.get("ground_truth", [])]
        bfcl_answers[data["id"]] = targets

# Build global pool of all 443 unique tools across BFCL_v3_multiple
global_tools_map = {}
for q in bfcl_questions:
    for fn in q["function"]:
        name = fn["name"]
        desc = fn.get("description") or name
        if name not in global_tools_map:
            global_tools_map[name] = {**fn, "description": desc}
        else:
            existing = global_tools_map[name]
            if desc and desc not in existing.get("description", ""):
                existing["description"] = f"{existing.get('description', '')} {desc}".strip()

global_tools_list = list(global_tools_map.values())

# All valid single-target multi-tool test items (N = 200, matching run_bfcl_eval.mjs)
bfcl_tests = []
for q in bfcl_questions:
    targets = bfcl_answers.get(q["id"], [])
    if len(targets) == 1 and len(q["function"]) >= 2:
        bfcl_tests.append({
            "id": q["id"],
            "query": q["question"][0][0]["content"],
            "target": targets[0],
            "candidates": q["function"],
        })


def build_catalog_100(test, idx):
    catalog = {fn["name"]: fn for fn in test["candidates"]}
    total_global = len(global_tools_list)
    cursor = (idx * 37) % total_global
    scanned = 0
    while len(catalog) < 100 and scanned < total_global:
        cand = global_tools_list[cursor]
        if cand["name"] not in catalog:
            catalog[cand["name"]] = cand
        cursor = (cursor + 1) % total_global
        scanned += 1
    return catalog


print("=" * 84)
print("BFCL v3 TOOL RETRIEVAL & SCHEMA PRUNING: TURBOVEC (RUST SIMD) & PURE PYTHON")
print(f"Dataset: Gorilla BFCL_v3_multiple | N = {len(bfcl_tests)} Queries | {len(global_tools_list)} Unique Tools")
print("=" * 84)

N = len(bfcl_tests)

# 1. Local Distractor Top-1 (2-4 tools, N = 200)
tv_distractor_correct = 0
py_distractor_correct = 0
tv_kernel_latencies = []
py_latencies = []

for test in bfcl_tests:
    cand_map = {fn["name"]: fn for fn in test["candidates"]}

    if _HAS_TURBOVEC:
        tv_eng = TurbovecEngine(dim=1024, bit_width=4)
        tv_eng.fit(cand_map)
        q_feats = extract_features(test["query"], 1.0, {}, True)
        q_vec_list, _, _ = tv_eng._embedder._embed_features(q_feats, True)
        q_vec = np.array(q_vec_list, dtype=np.float32).reshape(1, tv_eng.dim)
        t0 = time.perf_counter()
        _, indices = tv_eng.index.search(q_vec, k=1)
        tv_kernel_latencies.append((time.perf_counter() - t0) * 1000.0)
        if tv_eng.items[int(indices[0][0])] == test["target"]:
            tv_distractor_correct += 1

    py_eng = TurboQuantEngine(dim=1024)
    py_eng.fit(cand_map)
    t1 = time.perf_counter()
    py_res = py_eng.search(test["query"], top_k=1)
    py_latencies.append((time.perf_counter() - t1) * 1000.0)
    if py_res and py_res[0]["name"] == test["target"]:
        py_distractor_correct += 1

# 2. Deterministic 100-Tool Schema Pruning (N = 200, 0 skipped)
tv_100_top1 = tv_100_top3 = tv_100_top5 = 0
py_100_top1 = py_100_top3 = py_100_top5 = 0
tv_100_kernel_ms = []
tv_100_e2e_ms = []
py_100_e2e_ms = []

for idx, test in enumerate(bfcl_tests):
    catalog_100 = build_catalog_100(test, idx)

    if _HAS_TURBOVEC:
        tv_100 = TurbovecEngine(dim=1024, bit_width=4)
        tv_100.fit(catalog_100)
        q_feats = extract_features(test["query"], 1.0, {}, True)
        q_vec_list, _, _ = tv_100._embedder._embed_features(q_feats, True)
        q_vec = np.array(q_vec_list, dtype=np.float32).reshape(1, tv_100.dim)

        t_k = time.perf_counter()
        _, _ = tv_100.index.search(q_vec, k=5)
        tv_100_kernel_ms.append((time.perf_counter() - t_k) * 1000.0)

        t_e2e = time.perf_counter()
        tv_res = tv_100.search(test["query"], top_k=5)
        tv_100_e2e_ms.append((time.perf_counter() - t_e2e) * 1000.0)

        tv_names = [r["name"] for r in tv_res]
        if tv_names and tv_names[0] == test["target"]:
            tv_100_top1 += 1
        if test["target"] in tv_names[:3]:
            tv_100_top3 += 1
        if test["target"] in tv_names[:5]:
            tv_100_top5 += 1

    py_100 = TurboQuantEngine(dim=1024)
    py_100.fit(catalog_100)
    t_py = time.perf_counter()
    py_res = py_100.search(test["query"], top_k=5)
    py_100_e2e_ms.append((time.perf_counter() - t_py) * 1000.0)

    py_names = [r["name"] for r in py_res]
    if py_names and py_names[0] == test["target"]:
        py_100_top1 += 1
    if test["target"] in py_names[:3]:
        py_100_top3 += 1
    if test["target"] in py_names[:5]:
        py_100_top5 += 1

# 3. Full 443-Tool Global Pool Pruning (N = 200)
tv_443_top1 = tv_443_top3 = tv_443_top5 = 0
py_443_top1 = py_443_top3 = py_443_top5 = 0
tv_443_kernel_ms = []
py_443_e2e_ms = []

if _HAS_TURBOVEC:
    tv_443 = TurbovecEngine(dim=1024, bit_width=4)
    tv_443.fit(global_tools_map)

py_443 = TurboQuantEngine(dim=1024)
py_443.fit(global_tools_map)

for test in bfcl_tests:
    if _HAS_TURBOVEC:
        q_feats = extract_features(test["query"], 1.0, {}, True)
        q_vec_list, _, _ = tv_443._embedder._embed_features(q_feats, True)
        q_vec = np.array(q_vec_list, dtype=np.float32).reshape(1, tv_443.dim)

        t_k = time.perf_counter()
        _, _ = tv_443.index.search(q_vec, k=5)
        tv_443_kernel_ms.append((time.perf_counter() - t_k) * 1000.0)

        tv_names = [r["name"] for r in tv_443.search(test["query"], top_k=5)]
        if tv_names and tv_names[0] == test["target"]:
            tv_443_top1 += 1
        if test["target"] in tv_names[:3]:
            tv_443_top3 += 1
        if test["target"] in tv_names[:5]:
            tv_443_top5 += 1

    t_py = time.perf_counter()
    py_names = [r["name"] for r in py_443.search(test["query"], top_k=5)]
    py_443_e2e_ms.append((time.perf_counter() - t_py) * 1000.0)
    if py_names and py_names[0] == test["target"]:
        py_443_top1 += 1
    if test["target"] in py_names[:3]:
        py_443_top3 += 1
    if test["target"] in py_names[:5]:
        py_443_top5 += 1

print(f"\n--- 1. Local Distractor Selection (2-4 Tools, N = {N}) ---")
if _HAS_TURBOVEC:
    print(f"- Turbovec (Rust SIMD): {(tv_distractor_correct/N)*100:.1f}% ({tv_distractor_correct}/{N}) | {sum(tv_kernel_latencies)/N:.3f} ms SIMD kernel")
print(f"- Pure Python Stdlib:   {(py_distractor_correct/N)*100:.1f}% ({py_distractor_correct}/{N}) | {sum(py_latencies)/N:.3f} ms E2E")

print(f"\n--- 2. 100-Tool Schema Pruning (N = {N}, 0 Skipped) ---")
if _HAS_TURBOVEC:
    print(f"- Turbovec (Rust SIMD): Top-1 {(tv_100_top1/N)*100:.1f}% | Top-3 {(tv_100_top3/N)*100:.1f}% | Top-5 {(tv_100_top5/N)*100:.1f}% | {sum(tv_100_kernel_ms)/N:.3f} ms SIMD kernel ({sum(tv_100_e2e_ms)/N:.3f} ms E2E)")
print(f"- Pure Python Stdlib:   Top-1 {(py_100_top1/N)*100:.1f}% | Top-3 {(py_100_top3/N)*100:.1f}% | Top-5 {(py_100_top5/N)*100:.1f}% | {sum(py_100_e2e_ms)/N:.3f} ms E2E")

print(f"\n--- 3. Full {len(global_tools_list)}-Tool Global Pool Pruning (N = {N}) ---")
if _HAS_TURBOVEC:
    print(f"- Turbovec (Rust SIMD): Top-1 {(tv_443_top1/N)*100:.1f}% | Top-3 {(tv_443_top3/N)*100:.1f}% | Top-5 {(tv_443_top5/N)*100:.1f}% | {sum(tv_443_kernel_ms)/N:.3f} ms SIMD kernel")
print(f"- Pure Python Stdlib:   Top-1 {(py_443_top1/N)*100:.1f}% | Top-3 {(py_443_top3/N)*100:.1f}% | Top-5 {(py_443_top5/N)*100:.1f}% | {sum(py_443_e2e_ms)/N:.3f} ms E2E")
