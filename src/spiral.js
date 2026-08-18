// Line-segment + raycast-point buffers for days [i0, i1]. Missing days simply
// emit no segment, breaking the line.
//
// The work splits in two because the controls do: colours and the day index
// depend only on which element and colour ramp are showing, while positions
// depend on the Scale sliders, which the user scrubs. Rebuilding both on every
// scrub frame meant ~7 MB of fresh typed arrays 60 times a second, so a rebuild
// now keeps the topology and refills caller-owned position buffers in place.

const TAU = Math.PI * 2;

/**
 * Radius as a function of temperature, shared by the coil and by the grid rings
 * that annotate it: two copies of this mapping would let the 0 degC ring drift
 * off the part of the coil it claims to mark.
 *
 * The power warp around 0 degC pushes extremes disproportionally outward when
 * rExp > 1 and compresses them when rExp < 1. K renormalizes so the all-time
 * extreme keeps its linear-scale radius and only the shape of the mapping
 * changes. tFloor is the all-time minimum, so radius = rBase at the coldest
 * measured day (the "base circle").
 */
export function makeRadius({ rBase, rPerDeg, rExp, tFloor, tAbsMax }) {
  const K = tAbsMax ** (1 - rExp);
  const warp = t => Math.sign(t) * Math.abs(t) ** rExp * K;
  const wFloor = warp(tFloor);
  return t => rBase + (warp(t) - wFloor) * rPerDeg;
}

/**
 * Everything about the range that survives a Scale-slider change: per-vertex
 * colours, which days actually have a value, the playback draw cursors, and the
 * range stats. Colors are rgba (LOCAL MOD in vendor/lines/); alpha is constant 1
 * today — depth dimming happens via scene fog — but the channel is plumbed
 * through.
 */
export function buildTopology(data, { i0, i1, ramp }) {
  const { temps } = data;
  const count = i1 - i0 + 1;
  const segCol = new Float32Array((count - 1) * 8);
  const ptDay = new Int32Array(count);
  // cumulative segment / point counts per day, for the playback draw cursor
  const cumSeg = new Uint32Array(count);
  const cumPts = new Uint32Array(count);
  const { lut, cLo, cHi, lutN } = ramp;
  const lutK = (lutN - 1) / (cHi - cLo);

  let nSeg = 0, np = 0;
  let prevValid = false, pr = 0, pg = 0, pb = 0;
  let tMax = -Infinity, tMin = Infinity, tMaxI = -1, tMinI = -1, sum = 0, nValid = 0;

  for (let i = i0; i <= i1; i++) {
    const t = temps[i];
    if (t !== t) { prevValid = false; cumSeg[i - i0] = nSeg; cumPts[i - i0] = np; continue; }

    let li = Math.round((t - cLo) * lutK);
    li = li < 0 ? 0 : (li >= lutN ? lutN - 1 : li);
    const cr = lut[li * 3], cg = lut[li * 3 + 1], cb = lut[li * 3 + 2];

    ptDay[np] = i; np++;

    if (prevValid) {
      const c8 = nSeg * 8;
      segCol[c8] = pr; segCol[c8 + 1] = pg; segCol[c8 + 2] = pb; segCol[c8 + 3] = 1;
      segCol[c8 + 4] = cr; segCol[c8 + 5] = cg; segCol[c8 + 6] = cb; segCol[c8 + 7] = 1;
      nSeg++;
    }
    pr = cr; pg = cg; pb = cb;
    prevValid = true;
    cumSeg[i - i0] = nSeg;
    cumPts[i - i0] = np;

    if (t > tMax) { tMax = t; tMaxI = i; }
    if (t < tMin) { tMin = t; tMinI = i; }
    sum += t; nValid++;
  }

  return {
    segCol: segCol.subarray(0, nSeg * 8),
    ptDay: ptDay.subarray(0, np),
    cumSeg, cumPts, nSeg, np,
    stats: { tMax, tMaxI, tMin, tMinI, mean: sum / nValid, nValid, missing: count - nValid },
  };
}

/**
 * Refills the position buffers for a topology. segPos/ptPos are owned by the
 * caller and sized nSeg*6 / np*3, so a slider scrub reuses them.
 */
export function fillPositions(data, topo, { i0, i1, rOf, vPerDay, segPos, ptPos }) {
  const { temps, frac } = data;
  const { ptDay, np } = topo;

  for (let k = 0; k < np; k++) {
    const i = ptDay[k];
    const r = rOf(temps[i]);
    const a = frac[i] * TAU;
    ptPos[k * 3] = r * Math.sin(a);
    ptPos[k * 3 + 1] = (i - i0) * vPerDay;
    ptPos[k * 3 + 2] = -r * Math.cos(a);
  }

  // A segment exists exactly where buildTopology emitted one: between two valid
  // points on consecutive days. Same order, so it matches cumSeg.
  let s = 0;
  for (let k = 1; k < np; k++) {
    if (ptDay[k] !== ptDay[k - 1] + 1) continue;
    const a3 = (k - 1) * 3, b3 = k * 3, p6 = s * 6;
    segPos[p6] = ptPos[a3]; segPos[p6 + 1] = ptPos[a3 + 1]; segPos[p6 + 2] = ptPos[a3 + 2];
    segPos[p6 + 3] = ptPos[b3]; segPos[p6 + 4] = ptPos[b3 + 1]; segPos[p6 + 5] = ptPos[b3 + 2];
    s++;
  }

  return {
    height: (i1 - i0) * vPerDay,
    maxR: rOf(topo.stats.tMax),   // rOf is monotonic, so the hottest day is the widest
  };
}
