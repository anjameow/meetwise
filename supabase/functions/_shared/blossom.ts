/**
 * Maximum-weight matching in general (non-bipartite) undirected graphs.
 *
 * Faithful TypeScript port of Joris van Rantwijk's `mwmatching.py`
 * (Edmonds' blossom algorithm with the O(n^3) primal-dual refinements of
 * Gabow / Galil, Micali & Gabow). Public domain in the original; this port
 * keeps the original structure, names and comments where practical.
 *
 * ZERO imports on purpose: this file is shared between Deno edge functions
 * and Node/vitest.
 *
 * Float handling
 * --------------
 * The original algorithm is exact only for integer weights (dual variables
 * stay integral and slack comparisons like `slack <= 0` are exact). Real
 * scores here are floats (e.g. 63.25), so every weight is scaled internally
 * to an integer with `Math.round(w * WEIGHT_SCALE)` (WEIGHT_SCALE = 1000,
 * i.e. weights are effectively quantised to 0.001). All internal arithmetic
 * is then exact integer arithmetic in doubles (safe as long as
 * |w| * 1000 * n stays well below 2^53). Two weights differing by less than
 * ~0.0005 may be treated as equal; ties are broken deterministically.
 *
 * Output is deterministic for identical input (no randomness, no reliance on
 * object/hash iteration order).
 */

const WEIGHT_SCALE = 1000;

/**
 * Compute a maximum-weighted matching in the general undirected weighted
 * graph given by `edges`, a list of `[i, j, weight]` with vertices numbered
 * 0..n-1 (n inferred as max index + 1). Each edge must have i !== j.
 *
 * If `maxCardinality` is true, only maximum-cardinality matchings are
 * considered as solutions (and among those the maximum-weight one is chosen).
 *
 * Returns `mate` such that `mate[i] === j` if vertex i is matched to j, or
 * `mate[i] === -1` if vertex i is unmatched. Empty edge list returns `[]`.
 */
export function maxWeightMatching(
  edges: Array<[number, number, number]>,
  maxCardinality = false,
): number[] {
  if (edges.length === 0) return [];

  const nedge = edges.length;
  let nvertex = 0;
  const ev: number[] = new Array(nedge);
  const ew: number[] = new Array(nedge);
  const ewt: number[] = new Array(nedge);
  for (let k = 0; k < nedge; k++) {
    const [i, j, w] = edges[k];
    if (
      !Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 ||
      i === j
    ) {
      throw new Error(`maxWeightMatching: invalid edge [${i}, ${j}]`);
    }
    if (!Number.isFinite(w)) {
      throw new Error(`maxWeightMatching: invalid weight ${w}`);
    }
    ev[k] = i;
    ew[k] = j;
    ewt[k] = Math.round(w * WEIGHT_SCALE);
    if (i >= nvertex) nvertex = i + 1;
    if (j >= nvertex) nvertex = j + 1;
  }

  // Find the maximum edge weight.
  let maxweight = 0;
  for (let k = 0; k < nedge; k++) if (ewt[k] > maxweight) maxweight = ewt[k];

  // If p is an edge endpoint, endpoint[p] is the vertex to which endpoint p
  // is attached. Edge k has endpoints 2k and 2k+1.
  const endpoint: number[] = new Array(2 * nedge);
  for (let p = 0; p < 2 * nedge; p++) {
    endpoint[p] = (p & 1) === 0 ? ev[p >> 1] : ew[p >> 1];
  }

  // neighbend[v] is the list of remote endpoints of the edges attached to v.
  const neighbend: number[][] = [];
  for (let v = 0; v < nvertex; v++) neighbend.push([]);
  for (let k = 0; k < nedge; k++) {
    neighbend[ev[k]].push(2 * k + 1);
    neighbend[ew[k]].push(2 * k);
  }

  // mate[v] is the remote endpoint of its matched edge, or -1 if single.
  const mate: number[] = new Array(nvertex).fill(-1);

  // label[b]: 0 = free, 1 = S-vertex/blossom, 2 = T-vertex/blossom.
  // (5 is used transiently by scanBlossom.)
  const label: number[] = new Array(2 * nvertex).fill(0);

  // labelend[b] is the remote endpoint of the edge through which b obtained
  // its label, or -1 if b's base vertex is single.
  const labelend: number[] = new Array(2 * nvertex).fill(-1);

  // inblossom[v] is the top-level blossom to which vertex v belongs.
  const inblossom: number[] = new Array(nvertex);
  for (let v = 0; v < nvertex; v++) inblossom[v] = v;

  // blossomparent[b] is b's immediate parent (sub-)blossom, or -1.
  const blossomparent: number[] = new Array(2 * nvertex).fill(-1);

  // blossomchilds[b] is an ordered list of b's sub-blossoms, starting with
  // the base and going round the blossom.
  const blossomchilds: (number[] | null)[] = new Array(2 * nvertex).fill(null);

  // blossombase[b] is the base vertex of blossom b.
  const blossombase: number[] = new Array(2 * nvertex).fill(-1);
  for (let v = 0; v < nvertex; v++) blossombase[v] = v;

  // blossomendps[b] is a list of endpoints on b's connecting edges, such that
  // blossomendps[b][i] is the local endpoint of blossomchilds[b][i] on the
  // edge that connects it to blossomchilds[b][wrap(i+1)].
  const blossomendps: (number[] | null)[] = new Array(2 * nvertex).fill(null);

  // If v is a free vertex (or an unreached vertex inside a T-blossom),
  // bestedge[v] is the edge to an S-vertex with least slack, or -1.
  // If b is a (sub-)blossom, bestedge[b] is the least-slack edge to a
  // different S-blossom, or -1.
  const bestedge: number[] = new Array(2 * nvertex).fill(-1);

  // If b is a non-trivial top-level S-blossom, blossombestedges[b] is a list
  // of least-slack edges to neighbouring S-blossoms, or null.
  const blossombestedges: (number[] | null)[] = new Array(2 * nvertex).fill(
    null,
  );

  // List of currently unused blossom numbers.
  const unusedblossoms: number[] = [];
  for (let b = nvertex; b < 2 * nvertex; b++) unusedblossoms.push(b);

  // Dual variables (all values are 2x the "real" duals so that everything
  // stays integral: slack = u_i + u_j - 2w).
  const dualvar: number[] = new Array(2 * nvertex).fill(0);
  for (let v = 0; v < nvertex; v++) dualvar[v] = maxweight;

  // allowedge[k] is true if edge k has zero slack in the optimization
  // problem; false if the edge's slack may or may not be zero.
  const allowedge: boolean[] = new Array(nedge).fill(false);

  // Queue of newly discovered S-vertices.
  let queue: number[] = [];

  // Return 2 * slack of edge k (does not work inside blossoms).
  function slack(k: number): number {
    return dualvar[ev[k]] + dualvar[ew[k]] - 2 * ewt[k];
  }

  // Generate the leaf vertices of a blossom.
  function blossomLeaves(b: number, out: number[] = []): number[] {
    if (b < nvertex) {
      out.push(b);
    } else {
      for (const t of blossomchilds[b] as number[]) {
        if (t < nvertex) out.push(t);
        else blossomLeaves(t, out);
      }
    }
    return out;
  }

  // Assign label t to the top-level blossom containing vertex w and record
  // the fact that w was reached through the edge with remote endpoint p.
  function assignLabel(w: number, t: number, p: number): void {
    const b = inblossom[w];
    label[w] = label[b] = t;
    labelend[w] = labelend[b] = p;
    bestedge[w] = bestedge[b] = -1;
    if (t === 1) {
      // b became an S-vertex/blossom; add it(s vertices) to the queue.
      blossomLeaves(b, queue);
    } else if (t === 2) {
      // b became a T-vertex/blossom; assign label S to its mate.
      // (If b is a non-trivial blossom, its base is the only vertex with an
      // external mate.)
      const base = blossombase[b];
      assignLabel(endpoint[mate[base]], 1, mate[base] ^ 1);
    }
  }

  // Trace back from vertices v and w to discover either a new blossom or an
  // augmenting path. Return the base vertex of the new blossom or -1.
  function scanBlossom(v: number, w: number): number {
    const path: number[] = [];
    let base = -1;
    while (v !== -1 || w !== -1) {
      // Look for a breadcrumb in v's blossom or put a new breadcrumb.
      let b = inblossom[v];
      if (label[b] & 4) {
        base = blossombase[b];
        break;
      }
      path.push(b);
      label[b] = 5;
      // Trace one step back.
      if (labelend[b] === -1) {
        // The base of blossom b is single; stop tracing this path.
        v = -1;
      } else {
        v = endpoint[labelend[b]];
        b = inblossom[v];
        // b is a T-blossom; trace one more step back.
        v = endpoint[labelend[b]];
      }
      // Swap v and w so that we alternate between both paths.
      if (w !== -1) {
        const tmp = v;
        v = w;
        w = tmp;
      }
    }
    // Remove breadcrumbs.
    for (const b of path) label[b] = 1;
    return base;
  }

  // Construct a new blossom with given base, containing edge k which
  // connects a pair of S vertices. Label the new blossom as S; set its dual
  // variable to zero; relabel its T-vertices to S and add them to the queue.
  function addBlossom(base: number, k: number): void {
    let v = ev[k];
    let w = ew[k];
    const bb = inblossom[base];
    let bv = inblossom[v];
    let bw = inblossom[w];
    // Create blossom.
    const b = unusedblossoms.pop() as number;
    blossombase[b] = base;
    blossomparent[b] = -1;
    blossomparent[bb] = b;
    // Make list of sub-blossoms and their interconnecting edge endpoints.
    const path: number[] = [];
    const endps: number[] = [];
    blossomchilds[b] = path;
    blossomendps[b] = endps;
    // Trace back from v to base.
    while (bv !== bb) {
      // Add bv to the new blossom.
      blossomparent[bv] = b;
      path.push(bv);
      endps.push(labelend[bv]);
      // Trace one step back.
      v = endpoint[labelend[bv]];
      bv = inblossom[v];
    }
    // Reverse lists, add endpoint that connects the pair of S vertices.
    path.push(bb);
    path.reverse();
    endps.reverse();
    endps.push(2 * k);
    // Trace back from w to base.
    while (bw !== bb) {
      // Add bw to the new blossom.
      blossomparent[bw] = b;
      path.push(bw);
      endps.push(labelend[bw] ^ 1);
      // Trace one step back.
      w = endpoint[labelend[bw]];
      bw = inblossom[w];
    }
    // Set label to S.
    label[b] = 1;
    labelend[b] = labelend[bb];
    // Set dual variable to zero.
    dualvar[b] = 0;
    // Relabel vertices.
    for (const lv of blossomLeaves(b)) {
      if (label[inblossom[lv]] === 2) {
        // This T-vertex now turns into an S-vertex because it becomes part
        // of an S-blossom; add it to the queue.
        queue.push(lv);
      }
      inblossom[lv] = b;
    }
    // Compute blossombestedges[b].
    const bestedgeto: number[] = new Array(2 * nvertex).fill(-1);
    for (const sbv of path) {
      let nblists: number[][];
      if (blossombestedges[sbv] === null) {
        // This subblossom does not have a list of least-slack edges; get
        // the information from the vertices.
        nblists = [];
        for (const lv of blossomLeaves(sbv)) {
          nblists.push(neighbend[lv].map((p) => p >> 1));
        }
      } else {
        // Walk this subblossom's least-slack edges.
        nblists = [blossombestedges[sbv] as number[]];
      }
      for (const nblist of nblists) {
        for (const kk of nblist) {
          let i = ev[kk];
          let j = ew[kk];
          if (inblossom[j] === b) {
            const tmp = i;
            i = j;
            j = tmp;
          }
          const bj = inblossom[j];
          if (
            bj !== b && label[bj] === 1 &&
            (bestedgeto[bj] === -1 || slack(kk) < slack(bestedgeto[bj]))
          ) {
            bestedgeto[bj] = kk;
          }
        }
      }
      // Forget about least-slack edges of the subblossom.
      blossombestedges[sbv] = null;
      bestedge[sbv] = -1;
    }
    const bbe = bestedgeto.filter((kk) => kk !== -1);
    blossombestedges[b] = bbe;
    // Select bestedge[b].
    bestedge[b] = -1;
    for (const kk of bbe) {
      if (bestedge[b] === -1 || slack(kk) < slack(bestedge[b])) {
        bestedge[b] = kk;
      }
    }
  }

  // Expand the given top-level blossom.
  function expandBlossom(b: number, endstage: boolean): void {
    const childs = blossomchilds[b] as number[];
    const endpsB = blossomendps[b] as number[];
    // Convert sub-blossoms into top-level blossoms.
    for (const s of childs) {
      blossomparent[s] = -1;
      if (s < nvertex) {
        inblossom[s] = s;
      } else if (endstage && dualvar[s] === 0) {
        // Recursively expand this sub-blossom.
        expandBlossom(s, endstage);
      } else {
        for (const v of blossomLeaves(s)) inblossom[v] = s;
      }
    }
    // If we expand a T-blossom during a stage, its sub-blossoms must be
    // relabeled.
    if (!endstage && label[b] === 2) {
      // Start at the sub-blossom through which the expanding blossom
      // obtained its label, and relabel sub-blossoms until we reach the base.
      // Figure out through which sub-blossom the expanding blossom obtained
      // its label initially.
      const entrychild = inblossom[endpoint[labelend[b] ^ 1]];
      // Decide in which direction we will go round the blossom.
      const len = childs.length;
      let j = childs.indexOf(entrychild);
      let jstep: number;
      let endptrick: number;
      if (j & 1) {
        // Start index is odd; go forward and wrap.
        j -= len;
        jstep = 1;
        endptrick = 0;
      } else {
        // Start index is even; go backward.
        jstep = -1;
        endptrick = 1;
      }
      const at = <T>(arr: T[], idx: number): T =>
        arr[idx < 0 ? idx + arr.length : idx];
      // Move along the blossom until we get to the base.
      let p = labelend[b];
      while (j !== 0) {
        // Relabel the T-sub-blossom.
        label[endpoint[p ^ 1]] = 0;
        label[endpoint[at(endpsB, j - endptrick) ^ endptrick ^ 1]] = 0;
        assignLabel(endpoint[p ^ 1], 2, p);
        // Step to the next S-sub-blossom and note its forward endpoint.
        allowedge[at(endpsB, j - endptrick) >> 1] = true;
        j += jstep;
        p = at(endpsB, j - endptrick) ^ endptrick;
        // Step to the next T-sub-blossom.
        allowedge[p >> 1] = true;
        j += jstep;
      }
      // Relabel the base T-sub-blossom WITHOUT stepping through to its mate
      // (so don't call assignLabel).
      let bv = at(childs, j);
      label[endpoint[p ^ 1]] = label[bv] = 2;
      labelend[endpoint[p ^ 1]] = labelend[bv] = p;
      bestedge[bv] = -1;
      // Continue along the blossom until we get back to entrychild.
      j += jstep;
      while (at(childs, j) !== entrychild) {
        // Examine the vertices of the sub-blossom to see whether it is
        // reachable from a neighbouring S-vertex outside the expanding
        // blossom.
        bv = at(childs, j);
        if (label[bv] === 1) {
          // This sub-blossom just got label S through one of its neighbours;
          // leave it.
          j += jstep;
          continue;
        }
        let found = -1;
        for (const v of blossomLeaves(bv)) {
          if (label[v] !== 0) {
            found = v;
            break;
          }
        }
        // If the sub-blossom contains a reachable vertex, assign label T to
        // the sub-blossom.
        if (found !== -1) {
          const v = found;
          label[v] = 0;
          label[endpoint[mate[blossombase[bv]]]] = 0;
          assignLabel(v, 2, labelend[v]);
        }
        j += jstep;
      }
    }
    // Recycle the blossom number.
    label[b] = labelend[b] = -1;
    blossomchilds[b] = blossomendps[b] = null;
    blossombase[b] = -1;
    blossombestedges[b] = null;
    bestedge[b] = -1;
    unusedblossoms.push(b);
  }

  // Swap matched/unmatched edges over an alternating path through blossom b
  // between vertex v and the base vertex. Keep blossom bookkeeping
  // consistent.
  function augmentBlossom(b: number, v: number): void {
    // Bubble up through the blossom tree from vertex v to an immediate
    // sub-blossom of b.
    let t = v;
    while (blossomparent[t] !== b) t = blossomparent[t];
    // Recursively deal with the first sub-blossom.
    if (t >= nvertex) augmentBlossom(t, v);
    // Decide in which direction we will go round the blossom.
    const childs = blossomchilds[b] as number[];
    const endpsB = blossomendps[b] as number[];
    const len = childs.length;
    const i = childs.indexOf(t);
    let j = i;
    let jstep: number;
    let endptrick: number;
    if (i & 1) {
      // Start index is odd; go forward and wrap.
      j -= len;
      jstep = 1;
      endptrick = 0;
    } else {
      // Start index is even; go backward.
      jstep = -1;
      endptrick = 1;
    }
    const at = <T>(arr: T[], idx: number): T =>
      arr[idx < 0 ? idx + arr.length : idx];
    // Move along the blossom until we get to the base.
    while (j !== 0) {
      // Step to the next sub-blossom and augment it recursively.
      j += jstep;
      t = at(childs, j);
      const p = at(endpsB, j - endptrick) ^ endptrick;
      if (t >= nvertex) augmentBlossom(t, endpoint[p]);
      // Step to the next sub-blossom and augment it recursively.
      j += jstep;
      t = at(childs, j);
      if (t >= nvertex) augmentBlossom(t, endpoint[p ^ 1]);
      // Match the edge connecting those sub-blossoms.
      mate[endpoint[p]] = p ^ 1;
      mate[endpoint[p ^ 1]] = p;
    }
    // Rotate the list of sub-blossoms to put the new base at the front.
    blossomchilds[b] = childs.slice(i).concat(childs.slice(0, i));
    blossomendps[b] = endpsB.slice(i).concat(endpsB.slice(0, i));
    blossombase[b] = blossombase[(blossomchilds[b] as number[])[0]];
  }

  // Swap matched/unmatched edges over an alternating path between two
  // single vertices. The augmenting path runs through edge k, which
  // connects a pair of S vertices.
  function augmentMatching(k: number): void {
    const pairs: Array<[number, number]> = [
      [ev[k], 2 * k + 1],
      [ew[k], 2 * k],
    ];
    for (let [s, p] of pairs) {
      // Match vertex s to remote endpoint p. Then trace back from s until we
      // find a single vertex, swapping matched and unmatched edges as we go.
      for (;;) {
        const bs = inblossom[s];
        // Augment through the S-blossom from s to base.
        if (bs >= nvertex) augmentBlossom(bs, s);
        // Update mate[s]
        mate[s] = p;
        // Trace one step back.
        if (labelend[bs] === -1) {
          // Reached single vertex; stop.
          break;
        }
        const t = endpoint[labelend[bs]];
        const bt = inblossom[t];
        // Trace one more step back.
        s = endpoint[labelend[bt]];
        const j = endpoint[labelend[bt] ^ 1];
        // Augment through the T-blossom from j to base.
        if (bt >= nvertex) augmentBlossom(bt, j);
        // Update mate[j]
        mate[j] = labelend[bt];
        // Keep the opposite endpoint; it will be assigned to mate[s] in the
        // next step.
        p = labelend[bt] ^ 1;
      }
    }
  }

  // Main loop: continue until no further improvement is possible.
  for (let stage = 0; stage < nvertex; stage++) {
    // Each iteration of this loop is a "stage". A stage finds an augmenting
    // path and uses that to improve the matching.

    // Remove labels from top-level blossoms/vertices.
    label.fill(0);
    // Forget all about least-slack edges.
    bestedge.fill(-1);
    for (let b = nvertex; b < 2 * nvertex; b++) blossombestedges[b] = null;
    // Loss of labeling means that we can not be sure that currently
    // allowable edges remain allowable throughout this stage.
    allowedge.fill(false);
    // Make queue empty.
    queue = [];

    // Label single blossoms/vertices with S and put them in the queue.
    for (let v = 0; v < nvertex; v++) {
      if (mate[v] === -1 && label[inblossom[v]] === 0) assignLabel(v, 1, -1);
    }

    // Loop until we succeed in augmenting the matching.
    let augmented = false;
    for (;;) {
      // Each iteration of this loop is a "substage". A substage tries to
      // find an augmenting path; if found, the path is used to improve the
      // matching and the stage ends. If there is no augmenting path, the
      // primal-dual method is used to pump some slack out of the dual
      // variables.

      // Continue labeling until all vertices which are reachable through an
      // alternating path have got a label.
      while (queue.length > 0 && !augmented) {
        // Take an S vertex from the queue.
        const v = queue.pop() as number;

        // Scan its neighbours:
        for (const p of neighbend[v]) {
          const k = p >> 1;
          const w = endpoint[p];
          // w is a neighbour to v
          if (inblossom[v] === inblossom[w]) {
            // this edge is internal to a blossom; ignore it
            continue;
          }
          let kslack = 0;
          if (!allowedge[k]) {
            kslack = slack(k);
            if (kslack <= 0) {
              // edge k has zero slack => it is allowable
              allowedge[k] = true;
            }
          }
          if (allowedge[k]) {
            if (label[inblossom[w]] === 0) {
              // (C1) w is a free vertex; label w with T and label its mate
              // with S (R12).
              assignLabel(w, 2, p ^ 1);
            } else if (label[inblossom[w]] === 1) {
              // (C2) w is an S-vertex (not in the same blossom); follow back-
              // links to discover either an augmenting path or a new blossom.
              const base = scanBlossom(v, w);
              if (base >= 0) {
                // Found a new blossom; add it to the blossom bookkeeping and
                // turn it into an S-blossom.
                addBlossom(base, k);
              } else {
                // Found an augmenting path; augment the matching and end
                // this stage.
                augmentMatching(k);
                augmented = true;
                break;
              }
            } else if (label[w] === 0) {
              // w is inside a T-blossom, but w itself has not yet been
              // reached from outside the blossom; mark it as reached (we
              // need this to relabel during T-blossom expansion).
              label[w] = 2;
              labelend[w] = p ^ 1;
            }
          } else if (label[inblossom[w]] === 1) {
            // keep track of the least-slack non-allowable edge to a
            // different S-blossom.
            const b = inblossom[v];
            if (bestedge[b] === -1 || kslack < slack(bestedge[b])) {
              bestedge[b] = k;
            }
          } else if (label[w] === 0) {
            // w is a free vertex (or an unreached vertex inside a
            // T-blossom) but we can not reach it yet; keep track of the
            // least-slack edge that reaches w.
            if (bestedge[w] === -1 || kslack < slack(bestedge[w])) {
              bestedge[w] = k;
            }
          }
        }
      }

      if (augmented) break;

      // There is no augmenting path under these constraints; compute delta
      // and reduce slack in the optimization problem.
      // (Note that our vertex dual variables, edge slacks and delta's are
      // pre-multiplied by two.)
      let deltatype = -1;
      let delta = 0;
      let deltaedge = -1;
      let deltablossom = -1;

      // Compute delta1: the minimum value of any vertex dual.
      if (!maxCardinality) {
        deltatype = 1;
        delta = Infinity;
        for (let v = 0; v < nvertex; v++) {
          if (dualvar[v] < delta) delta = dualvar[v];
        }
      }

      // Compute delta2: the minimum slack on any edge between an S-vertex
      // and a free vertex.
      for (let v = 0; v < nvertex; v++) {
        if (label[inblossom[v]] === 0 && bestedge[v] !== -1) {
          const d = slack(bestedge[v]);
          if (deltatype === -1 || d < delta) {
            delta = d;
            deltatype = 2;
            deltaedge = bestedge[v];
          }
        }
      }

      // Compute delta3: half the minimum slack on any edge between a pair of
      // S-blossoms. (Slack is even because all weights are integers here.)
      for (let b = 0; b < 2 * nvertex; b++) {
        if (blossomparent[b] === -1 && label[b] === 1 && bestedge[b] !== -1) {
          const kslack = slack(bestedge[b]);
          const d = kslack / 2;
          if (deltatype === -1 || d < delta) {
            delta = d;
            deltatype = 3;
            deltaedge = bestedge[b];
          }
        }
      }

      // Compute delta4: minimum z variable of any T-blossom.
      for (let b = nvertex; b < 2 * nvertex; b++) {
        if (
          blossombase[b] >= 0 && blossomparent[b] === -1 && label[b] === 2 &&
          (deltatype === -1 || dualvar[b] < delta)
        ) {
          delta = dualvar[b];
          deltatype = 4;
          deltablossom = b;
        }
      }

      if (deltatype === -1) {
        // No further improvement possible; max-cardinality optimum reached.
        // Do a final delta update to make the optimum verifyable.
        deltatype = 1;
        let mn = Infinity;
        for (let v = 0; v < nvertex; v++) if (dualvar[v] < mn) mn = dualvar[v];
        delta = Math.max(0, mn);
      }

      // Update dual variables according to delta.
      for (let v = 0; v < nvertex; v++) {
        const lb = label[inblossom[v]];
        if (lb === 1) {
          // S-vertex: 2*u = 2*u - 2*delta
          dualvar[v] -= delta;
        } else if (lb === 2) {
          // T-vertex: 2*u = 2*u + 2*delta
          dualvar[v] += delta;
        }
      }
      for (let b = nvertex; b < 2 * nvertex; b++) {
        if (blossombase[b] >= 0 && blossomparent[b] === -1) {
          if (label[b] === 1) {
            // top-level S-blossom: z = z + 2*delta
            dualvar[b] += delta;
          } else if (label[b] === 2) {
            // top-level T-blossom: z = z - 2*delta
            dualvar[b] -= delta;
          }
        }
      }

      // Take action at the point where minimum delta occurred.
      if (deltatype === 1) {
        // No further improvement possible; optimum reached.
        break;
      } else if (deltatype === 2) {
        // Use the least-slack edge to continue the search.
        allowedge[deltaedge] = true;
        let i = ev[deltaedge];
        const j = ew[deltaedge];
        if (label[inblossom[i]] === 0) i = j;
        queue.push(i);
      } else if (deltatype === 3) {
        // Use the least-slack edge to continue the search.
        allowedge[deltaedge] = true;
        queue.push(ev[deltaedge]);
      } else if (deltatype === 4) {
        // Expand the least-z blossom.
        expandBlossom(deltablossom, false);
      }
      // End of a this substage.
    }

    // Stop when no more augmenting path can be found.
    if (!augmented) break;

    // End of a stage; expand all S-blossoms which have dualvar = 0.
    for (let b = nvertex; b < 2 * nvertex; b++) {
      if (
        blossomparent[b] === -1 && blossombase[b] >= 0 && label[b] === 1 &&
        dualvar[b] === 0
      ) {
        expandBlossom(b, true);
      }
    }
  }

  // Transform mate[] such that mate[v] is the vertex to which v is paired.
  for (let v = 0; v < nvertex; v++) {
    if (mate[v] >= 0) mate[v] = endpoint[mate[v]];
  }
  return mate;
}
