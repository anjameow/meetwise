import { describe, expect, it } from "vitest";
import { maxWeightMatching } from "../../supabase/functions/_shared/blossom.ts";

type Edge = [number, number, number];

describe("maxWeightMatching (ported mwmatching.py tests)", () => {
  it("test10_empty", () => {
    expect(maxWeightMatching([])).toEqual([]);
  });

  it("test11_singleedge", () => {
    expect(maxWeightMatching([[0, 1, 1]])).toEqual([1, 0]);
  });

  it("test12", () => {
    expect(maxWeightMatching([[1, 2, 10], [2, 3, 11]])).toEqual([-1, -1, 3, 2]);
  });

  it("test13", () => {
    expect(maxWeightMatching([[1, 2, 5], [2, 3, 11], [3, 4, 5]])).toEqual([
      -1, -1, 3, 2, -1,
    ]);
  });

  it("test14_maxcard", () => {
    expect(
      maxWeightMatching([[1, 2, 5], [2, 3, 11], [3, 4, 5]], true),
    ).toEqual([-1, 2, 1, 4, 3]);
  });

  it("test15_float", () => {
    expect(
      maxWeightMatching([
        [1, 2, Math.PI],
        [2, 3, Math.E],
        [1, 3, 3.0],
        [1, 4, Math.sqrt(2.0)],
      ]),
    ).toEqual([-1, 4, 3, 2, 1]);
  });

  it("test16_negative", () => {
    const edges: Edge[] = [
      [1, 2, 2],
      [1, 3, -2],
      [2, 3, 1],
      [2, 4, -1],
      [3, 4, -6],
    ];
    expect(maxWeightMatching(edges, false)).toEqual([-1, 2, 1, -1, -1]);
    expect(maxWeightMatching(edges, true)).toEqual([-1, 3, 4, 1, 2]);
  });

  it("test20_sblossom", () => {
    expect(
      maxWeightMatching([[1, 2, 8], [1, 3, 9], [2, 3, 10], [3, 4, 7]]),
    ).toEqual([-1, 2, 1, 4, 3]);
    expect(
      maxWeightMatching([
        [1, 2, 8],
        [1, 3, 9],
        [2, 3, 10],
        [3, 4, 7],
        [1, 6, 5],
        [4, 5, 6],
      ]),
    ).toEqual([-1, 6, 3, 2, 5, 4, 1]);
  });

  it("test21_tblossom", () => {
    expect(
      maxWeightMatching([
        [1, 2, 9],
        [1, 3, 8],
        [2, 3, 10],
        [1, 4, 5],
        [4, 5, 4],
        [1, 6, 3],
      ]),
    ).toEqual([-1, 6, 3, 2, 5, 4, 1]);
    expect(
      maxWeightMatching([
        [1, 2, 9],
        [1, 3, 8],
        [2, 3, 10],
        [1, 4, 5],
        [4, 5, 3],
        [1, 6, 4],
      ]),
    ).toEqual([-1, 6, 3, 2, 5, 4, 1]);
    expect(
      maxWeightMatching([
        [1, 2, 9],
        [1, 3, 8],
        [2, 3, 10],
        [1, 4, 5],
        [4, 5, 3],
        [3, 6, 4],
      ]),
    ).toEqual([-1, 2, 1, 6, 5, 4, 3]);
  });

  it("test22_s_nest", () => {
    expect(
      maxWeightMatching([
        [1, 2, 9],
        [1, 3, 9],
        [2, 3, 10],
        [2, 4, 8],
        [3, 5, 8],
        [4, 5, 10],
        [5, 6, 6],
      ]),
    ).toEqual([-1, 3, 4, 1, 2, 6, 5]);
  });

  it("test23_s_relabel_nest", () => {
    expect(
      maxWeightMatching([
        [1, 2, 10],
        [1, 7, 10],
        [2, 3, 12],
        [3, 4, 20],
        [3, 5, 20],
        [4, 5, 25],
        [5, 6, 10],
        [6, 7, 10],
        [7, 8, 8],
      ]),
    ).toEqual([-1, 2, 1, 4, 3, 6, 5, 8, 7]);
  });

  it("test24_s_nest_expand", () => {
    expect(
      maxWeightMatching([
        [1, 2, 8],
        [1, 3, 8],
        [2, 3, 10],
        [2, 4, 12],
        [3, 5, 12],
        [4, 5, 14],
        [4, 6, 12],
        [5, 7, 12],
        [6, 7, 14],
        [7, 8, 12],
      ]),
    ).toEqual([-1, 2, 1, 5, 6, 3, 4, 8, 7]);
  });

  it("test25_s_t_expand", () => {
    expect(
      maxWeightMatching([
        [1, 2, 23],
        [1, 5, 22],
        [1, 6, 15],
        [2, 3, 25],
        [3, 4, 22],
        [4, 5, 25],
        [4, 8, 14],
        [5, 7, 13],
      ]),
    ).toEqual([-1, 6, 3, 2, 8, 7, 1, 5, 4]);
  });

  it("test26_s_nest_t_expand", () => {
    expect(
      maxWeightMatching([
        [1, 2, 19],
        [1, 3, 20],
        [1, 8, 8],
        [2, 3, 25],
        [2, 4, 18],
        [3, 5, 18],
        [4, 5, 13],
        [4, 7, 7],
        [5, 6, 7],
      ]),
    ).toEqual([-1, 8, 3, 2, 7, 6, 5, 4, 1]);
  });

  it("test30_tnasty_expand", () => {
    expect(
      maxWeightMatching([
        [1, 2, 45],
        [1, 5, 45],
        [2, 3, 50],
        [3, 4, 45],
        [4, 5, 50],
        [1, 6, 30],
        [3, 9, 35],
        [4, 8, 35],
        [5, 7, 26],
        [9, 10, 5],
      ]),
    ).toEqual([-1, 6, 3, 2, 8, 7, 1, 5, 4, 10, 9]);
  });

  it("test31_tnasty2_expand", () => {
    expect(
      maxWeightMatching([
        [1, 2, 45],
        [1, 5, 45],
        [2, 3, 50],
        [3, 4, 45],
        [4, 5, 50],
        [1, 6, 30],
        [3, 9, 35],
        [4, 8, 26],
        [5, 7, 40],
        [9, 10, 5],
      ]),
    ).toEqual([-1, 6, 3, 2, 8, 7, 1, 5, 4, 10, 9]);
  });

  it("test32_t_expand_leastslack", () => {
    expect(
      maxWeightMatching([
        [1, 2, 45],
        [1, 5, 45],
        [2, 3, 50],
        [3, 4, 45],
        [4, 5, 50],
        [1, 6, 30],
        [3, 9, 35],
        [4, 8, 28],
        [5, 7, 26],
        [9, 10, 5],
      ]),
    ).toEqual([-1, 6, 3, 2, 8, 7, 1, 5, 4, 10, 9]);
  });

  it("test33_nest_tnasty_expand", () => {
    expect(
      maxWeightMatching([
        [1, 2, 45],
        [1, 7, 45],
        [2, 3, 50],
        [3, 4, 45],
        [4, 5, 95],
        [4, 6, 94],
        [5, 6, 94],
        [6, 7, 50],
        [1, 8, 30],
        [3, 11, 35],
        [5, 9, 36],
        [7, 10, 26],
        [11, 12, 5],
      ]),
    ).toEqual([-1, 8, 3, 2, 6, 9, 4, 10, 1, 5, 7, 12, 11]);
  });

  it("test34_nest_relabel_expand", () => {
    expect(
      maxWeightMatching([
        [1, 2, 40],
        [1, 3, 40],
        [2, 3, 60],
        [2, 4, 55],
        [3, 5, 55],
        [4, 5, 50],
        [1, 8, 15],
        [5, 7, 30],
        [7, 6, 10],
        [8, 10, 10],
        [4, 9, 30],
      ]),
    ).toEqual([-1, 2, 1, 5, 9, 3, 7, 6, 10, 4, 8]);
  });
});

// ---------------------------------------------------------------------------
// Randomized brute-force comparison
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weights are generated as integer cents; returns weight in cents. */
const cents = (w: number) => Math.round(w * 100);

/**
 * Exhaustive search over all matchings. Returns best [cardinality, weightCents]
 * (lexicographic if maxCard, else just by weight).
 */
function bruteForce(
  n: number,
  edges: Edge[],
  maxCard: boolean,
): { card: number; weight: number } {
  const adj: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  for (const [i, j, w] of edges) {
    adj[i].push([j, cents(w)]);
    adj[j].push([i, cents(w)]);
  }
  const used = new Array(n).fill(false);
  let best = { card: 0, weight: 0 };
  const better = (c: number, w: number) =>
    maxCard
      ? c > best.card || (c === best.card && w > best.weight)
      : w > best.weight;
  function rec(v: number, card: number, weight: number) {
    while (v < n && used[v]) v++;
    if (v >= n) {
      if (better(card, weight)) best = { card, weight };
      return;
    }
    // v unmatched
    used[v] = true;
    rec(v + 1, card, weight);
    for (const [u, w] of adj[v]) {
      if (!used[u]) {
        used[u] = true;
        rec(v + 1, card + 1, weight + w);
        used[u] = false;
      }
    }
    used[v] = false;
  }
  rec(0, 0, 0);
  return best;
}

function checkValidAndScore(
  edges: Edge[],
  mate: number[],
): { card: number; weight: number } {
  const edgeW = new Map<string, number>();
  for (const [i, j, w] of edges) {
    const key = i < j ? `${i},${j}` : `${j},${i}`;
    const c = cents(w);
    // parallel edges: the best one is the one that would be used
    if (!edgeW.has(key) || (edgeW.get(key) as number) < c) edgeW.set(key, c);
  }
  let card = 0;
  let weight = 0;
  for (let i = 0; i < mate.length; i++) {
    const j = mate[i];
    if (j === -1) continue;
    expect(j).toBeGreaterThanOrEqual(0);
    expect(j).toBeLessThan(mate.length);
    expect(j).not.toBe(i);
    expect(mate[j]).toBe(i);
    if (i < j) {
      const key = `${i},${j}`;
      expect(edgeW.has(key)).toBe(true);
      card++;
      weight += edgeW.get(key) as number;
    }
  }
  return { card, weight };
}

describe("maxWeightMatching randomized vs brute force", () => {
  it("matches exhaustive search on ~300 random graphs (both modes)", () => {
    const rand = mulberry32(12345);
    let graphs = 0;
    for (let iter = 0; iter < 300; iter++) {
      const n = 2 + Math.floor(rand() * 9); // 2..10
      const density = 0.2 + rand() * 0.8;
      const edges: Edge[] = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (rand() < density) {
            const w = Math.round(rand() * 10000) / 100; // 0..100, 2 decimals
            edges.push(rand() < 0.5 ? [i, j, w] : [j, i, w]);
          }
        }
      }
      if (edges.length === 0) continue;
      graphs++;
      const nv = Math.max(...edges.map(([i, j]) => Math.max(i, j))) + 1;
      for (const maxCard of [false, true]) {
        const mate = maxWeightMatching(edges, maxCard);
        expect(mate.length).toBe(nv);
        const got = checkValidAndScore(edges, mate);
        const want = bruteForce(nv, edges, maxCard);
        if (maxCard) {
          expect([got.card, got.weight]).toEqual([want.card, want.weight]);
        } else {
          expect(got.weight).toBe(want.weight);
        }
      }
      // determinism
      expect(maxWeightMatching(edges)).toEqual(maxWeightMatching(edges));
    }
    expect(graphs).toBeGreaterThan(250);
  });

  it("handles negative and duplicate-ish weights vs brute force", () => {
    const rand = mulberry32(999);
    for (let iter = 0; iter < 100; iter++) {
      const n = 2 + Math.floor(rand() * 7);
      const edges: Edge[] = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (rand() < 0.6) {
            // few distinct values to create many ties, include negatives
            edges.push([i, j, Math.floor(rand() * 7) * 12.25 - 20]);
          }
        }
      }
      if (edges.length === 0) continue;
      const nv = Math.max(...edges.map(([i, j]) => Math.max(i, j))) + 1;
      for (const maxCard of [false, true]) {
        const got = checkValidAndScore(edges, maxWeightMatching(edges, maxCard));
        const want = bruteForce(nv, edges, maxCard);
        if (maxCard) {
          expect([got.card, got.weight]).toEqual([want.card, want.weight]);
        } else {
          expect(got.weight).toBe(want.weight);
        }
      }
    }
  });
});

describe("maxWeightMatching performance", () => {
  it("complete graph on 300 vertices finishes in < 10s", () => {
    const rand = mulberry32(42);
    const n = 300;
    const edges: Edge[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        edges.push([i, j, Math.round(rand() * 10000) / 100]);
      }
    }
    const t0 = performance.now();
    const mate = maxWeightMatching(edges);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(10_000);
    checkValidAndScore(edges, mate);
    // All weights are non-negative on a complete graph with even n:
    // a maximum-weight matching is perfect unless zero-weight edges intervene.
    expect(mate.filter((m) => m === -1).length).toBeLessThanOrEqual(2);
  }, 20_000);
});
