import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { LineSegments2 } from '../vendor/lines/LineSegments2.js';
import { LineSegmentsGeometry } from '../vendor/lines/LineSegmentsGeometry.js';
import { LineMaterial } from '../vendor/lines/LineMaterial.js';
import { loadData } from './data.js';
import { makeRadius, buildTopology, fillPositions } from './spiral.js';
import { makeRamp } from './colors.js';
import { initUI, setStats, setLegend, setFreshness, setYearBounds, syncControls, tooltipText } from './ui.js';

const stage = document.getElementById('stage');
const canvas = document.getElementById('view');
const labelLayer = document.getElementById('labels');
const tooltip = document.getElementById('tooltip');

// --- renderer boot ----------------------------------------------------------
//
// Context creation fails for two very different reasons and the recovery
// differs, so boot distinguishes them:
//
// 1. The browser has no working WebGL at all (blocklisted driver, GPU process
//    down). Nothing the page can do; the message points at chrome://gpu.
// 2. The browser is refusing contexts *for this page right now*: Chromium keeps
//    only ~16 alive browser-wide and drops the oldest, and it blocks a domain
//    from 3D APIs for a few seconds after it attributes context losses to it.
//    A reload-heavy session hits this constantly, and it clears by itself — so
//    retry with a backoff instead of declaring defeat, and offer a retry button.
const params = new URLSearchParams(location.search);

function hasAnyWebGL() {
  const probe = document.createElement('canvas');
  return !!(probe.getContext('webgl2') || probe.getContext('webgl'));
}

function showGlFailure(err) {
  const box = document.createElement('div');
  box.id = 'glFail';
  const headline = document.createElement('p');
  const retryable = hasAnyWebGL();
  headline.textContent = retryable
    ? 'The browser is refusing a WebGL context for this page.'
    : 'This browser reports no working WebGL.';
  const hint = document.createElement('p');
  hint.className = 'glFail-hint';
  hint.textContent = retryable
    ? 'Chromium drops the oldest context once ~16 are open browser-wide, and blocks a site from GPU contexts for a few seconds after repeated context losses. Retrying usually clears it. If it does not: close other tabs of this app, restart the browser (chrome://restart), or start the dev browser with --disable-domain-blocking-for-3d-apis.'
    : 'Check chrome://gpu (or about:support in Firefox) for a blocklisted driver, and whether hardware acceleration is enabled.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Retry';
  btn.addEventListener('click', () => location.reload());
  box.append(headline, hint, btn);
  stage.appendChild(box);
  console.error('WebGL context creation failed', err);
}

let renderer = null;
let glError = null;
for (const wait of [0, 400, 1200, 3000]) {
  if (wait) {
    await new Promise(done => setTimeout(done, wait));
  }
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    break;
  } catch (err) {
    glError = err;
  }
}
if (!renderer) {
  showGlFailure(glError);
  throw glError;
}
// ?dpr=1 renders at one device pixel per CSS pixel: cheaper on the GPU, and a
// way to check whether context losses are memory pressure.
renderer.setPixelRatio(Math.min(devicePixelRatio, +params.get('dpr') || 2));

// Hand the context back at once rather than waiting for the canvas to be
// collected, so a reload does not leave the previous one occupying one of the
// browser's slots. This is a synthetic loss through WEBGL_lose_context, not a
// GPU reset, so it is not the kind of event that gets a domain blocked.
//
// Except when the page is going into the bfcache: there the module is NOT
// re-executed on the way back, so nothing would ever undo this, and following
// the credit link and pressing Back would land on a dead canvas with no error
// box and no Retry. dispose() also stops the animation loop, hence the pageshow.
addEventListener('pagehide', e => {
  if (e.persisted) return;
  renderer.forceContextLoss();
  renderer.dispose();
});
addEventListener('pageshow', e => {
  if (e.persisted) renderer.setAnimationLoop(animate);
});
// preventDefault permits the browser to restore an evicted context; three.js
// re-initializes on the restored event, and a rebuild re-uploads the geometry.
canvas.addEventListener('webglcontextlost', e => {
  e.preventDefault();
  console.warn('WebGL context lost; waiting for the browser to restore it');
});
canvas.addEventListener('webglcontextrestored', () => {
  console.info('WebGL context restored');
  if (data) {
    rebuild();
  }
});
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111110);
// Depth cue: linear fog toward the bg color, retuned every frame to the
// camera-to-spiral geometry; state.fade sets how dim the far side gets.
scene.fog = new THREE.Fog(0x111110, 1e8, 1e9);
const cameraPersp = new THREE.PerspectiveCamera(50, 1, 0.1, 50000);
cameraPersp.position.set(0, 1, 0.001);
const cameraOrtho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 50000);
let camera = cameraPersp;
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const lineMat = new LineMaterial({ vertexColors: true, linewidth: 1.5, fog: true });
const ringMat = new THREE.LineBasicMaterial({ color: 0x2c2c2a, fog: false });
const zeroRingMat = new THREE.LineBasicMaterial({ color: 0x565349, fog: false });
const baseRingMat = new THREE.LineBasicMaterial({ color: 0x383835, fog: false });
const spineMat = new THREE.LineBasicMaterial({ color: 0x383835 });
const ptMat = new THREE.PointsMaterial({ size: 1 });
const markerMat = new THREE.MeshBasicMaterial({ color: 0xc99a4b });

const group = new THREE.Group();
scene.add(group);
const marker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), markerMat);
marker.visible = false;
scene.add(marker);

// Bulbs on the two ends of the drawn coil: [0] the first day of the range,
// [1] the last drawn day (so it rides the playhead). Fog off, so the far end
// stays legible whatever the depth cue does to the line.
const capGeom = new THREE.SphereGeometry(1, 16, 12);
const caps = [0, 1].map(() => {
  const cap = new THREE.Mesh(capGeom, new THREE.MeshBasicMaterial({ fog: false }));
  cap.visible = false;
  scene.add(cap);
  return cap;
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_MID = [15.5, 45, 74.5, 105, 135.5, 166, 196.5, 227.5, 258, 288.5, 319, 349.5];
const TAU = Math.PI * 2;

let data, ramp, tFloor;
// Playback: pos is an absolute day index (float); geometry is always fully
// built, the cursor only sets how many instanced segments get drawn.
const play = { active: false, engaged: false, pos: Infinity };
let lineGeomRef = null;
let lastHudIdx = -1;
let hudY = 0;
const yearAvgCache = new Map();
const hudEl = document.getElementById('hud');
const hudYear = document.getElementById('hudYear');
const hudDate = document.getElementById('hudDate');
const hudAvg = document.getElementById('hudAvg');
const DEFAULTS = {
  rPerDeg: 0.5, vPerDay: 0.0015, rBase: 10, rExp: 1, lineWidth: 1.5, fade: 0.75,
  element: 'tma', gamma: 1, projection: 'ortho', speed: 1000,
};
const state = { y0: 0, y1: 0, ...DEFAULTS };
let cur = { height: 1, maxR: 1, i0: 0 };
let points = null, ptDay = null;
// The coil's mesh, geometry and buffers outlive a rebuild. Only the topology
// (colours, valid days, draw cursors) has to be recomputed when the element,
// the colour ramp or the year range changes; a Scale-slider scrub reuses all of
// it and only refills positions. topoKey is what decides which of the two it is.
let coilMesh = null, coilGeom = null, ptGeom = null;
let topo = null, topoKey = '';
let segPos = null, ptPos = null;
let gridGroup = null, axisGroup = null;
const labels = [];
let tween = null;

// top: the label's y is ignored and the drawn top (hudY) used instead, so the
// label rides the playhead along with the grid it belongs to.
function addLabel(text, pos, cls = '', top = false) {
  const el = document.createElement('div');
  el.className = `lbl ${cls}`;
  el.textContent = text;
  labelLayer.appendChild(el);
  labels.push({ el, pos, top });
}

function circleGeometry(r, segments = 128) {
  const pos = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * TAU;
    pos[i * 3] = r * Math.sin(a);
    pos[i * 3 + 2] = -r * Math.cos(a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

function lineGeometry(...pts) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
  return g;
}

// Rebuild never touches the camera — zoom/pan/rotation survive every control
// change; framing is explicit (Fit / Top / Front / Reset).
function rebuild() {
  const i0 = data.firstIdx[state.y0 - data.startYear];
  const i1 = state.y1 === data.endYear ? data.n - 1 : data.firstIdx[state.y1 + 1 - data.startYear] - 1;

  labelLayer.replaceChildren();
  labels.length = 0;
  hideTooltip();

  const key = `${data.version}|${data.element}|${state.gamma}|${i0}|${i1}`;
  const freshTopology = key !== topoKey;
  if (freshTopology) {
    topo = buildTopology(data, { i0, i1, ramp });
    topoKey = key;
    segPos = new Float32Array(topo.nSeg * 6);
    ptPos = new Float32Array(topo.np * 3);
    ptDay = topo.ptDay;
  }

  const rOf = makeRadius({
    rBase: state.rBase, rPerDeg: state.rPerDeg, rExp: state.rExp, tFloor,
    tAbsMax: Math.max(Math.abs(data.meta.tmin), Math.abs(data.meta.tmax)),
  });
  const s = fillPositions(data, topo, { i0, i1, rOf, vPerDay: state.vPerDay, segPos, ptPos });

  cur = {
    height: s.height, maxR: s.maxR, fitR: s.maxR, i0,
    count: i1 - i0 + 1, cumSeg: topo.cumSeg, cumPts: topo.cumPts, ptPos,
  };

  if (!coilMesh) {
    coilGeom = new LineSegmentsGeometry();
    coilMesh = new LineSegments2(coilGeom, lineMat);
    coilMesh.frustumCulled = false;    // updateDepth already frames the whole coil
    ptGeom = new THREE.BufferGeometry();
    points = new THREE.Points(ptGeom, ptMat);
    points.visible = false;            // raycast target only
    group.add(coilMesh, points);
  }
  coilGeom.setPositions(segPos);
  if (freshTopology) {
    coilGeom.setColors(topo.segCol);
    ptGeom.setAttribute('position', new THREE.BufferAttribute(ptPos, 3));
  } else {
    ptGeom.attributes.position.needsUpdate = true;
  }
  ptGeom.computeBoundingSphere();      // Points.raycast culls against it
  lineGeomRef = coilGeom;

  // Base grid: the base circle (radius of the coldest measured day), then a
  // ring per 10 °C, 0 °C emphasized; labels along the July radial.
  const ringMax = rOf(40);
  cur.fitR = Math.max(cur.maxR, ringMax * 1.18);   // keep rim labels inside the frame
  // The grid sits at the drawn top rather than at y = 0: from the default
  // look-down view the base of the coil is the far end, where the depth fog
  // erases it. Riding the playhead also lines the month names up with the day
  // the HUD is reporting. applyPlayhead moves it.
  if (gridGroup) {
    gridGroup.traverse(o => o.geometry?.dispose());
    group.remove(gridGroup);
  }
  gridGroup = new THREE.Group();
  group.add(gridGroup);
  cur.grid = gridGroup;
  gridGroup.add(new THREE.LineLoop(circleGeometry(state.rBase), baseRingMat));
  for (let t = -20; t <= 40; t += 10) {
    const r = rOf(t);
    gridGroup.add(new THREE.LineLoop(circleGeometry(r), t === 0 ? zeroRingMat : ringMat));
    if (t % 20 === 0) addLabel(`${t}°`, new THREE.Vector3(0, 0, r), 'deg', true);
  }
  for (let m = 0; m < 12; m++) {
    const a = (MONTH_MID[m] / 365) * TAU;
    const r = ringMax * 1.13;
    addLabel(MONTHS[m], new THREE.Vector3(r * Math.sin(a), 0, -r * Math.cos(a)), 'month', true);
  }

  if (axisGroup) {
    axisGroup.traverse(o => o.geometry?.dispose());
    group.remove(axisGroup);
  }
  axisGroup = new THREE.Group();
  group.add(axisGroup);
  axisGroup.add(new THREE.Line(lineGeometry([0, 0, 0], [0, s.height, 0]), spineMat));
  const span = state.y1 - state.y0;
  const step = [1, 2, 5, 10, 20, 50].find(st => span / st <= 14) || 50;
  // Year axis outside the outer ring so labels never sit on top of the line work.
  const axisX = -ringMax * 1.04;
  for (let y = Math.ceil(state.y0 / step) * step; y <= state.y1; y += step) {
    const yy = (data.firstIdx[y - data.startYear] - i0) * state.vPerDay;
    axisGroup.add(new THREE.Line(lineGeometry([axisX, yy, 0], [axisX - ringMax * 0.04, yy, 0]), spineMat));
    addLabel(String(y), new THREE.Vector3(axisX - ringMax * 0.11, yy, 0), 'year');
  }

  marker.visible = false;
  marker.scale.setScalar(Math.max(s.maxR * 0.008, 0.001));
  setStats(topo.stats, data);

  // Only a placed playhead gets pulled into the new range. The Infinity sentinel
  // (stopped, or playing at speed 0) means "draw everything", and clamping it
  // here would pin the coil to the last range's final day, so widening the years
  // again would then draw nothing new.
  if (Number.isFinite(play.pos)) play.pos = Math.min(Math.max(play.pos, i0), i1);
  lastHudIdx = -1;
  applyPlayhead();
}

// --- playback ----------------------------------------------------------------

function yearAvg(year) {
  const key = `${data.element}:${year}`;
  if (!yearAvgCache.has(key)) {
    const a = data.firstIdx[year - data.startYear];
    const b = year === data.endYear ? data.n - 1 : data.firstIdx[year + 1 - data.startYear] - 1;
    let sum = 0, m = 0;
    for (let i = a; i <= b; i++) {
      const t = data.temps[i];
      if (t === t) { sum += t; m++; }
    }
    yearAvgCache.set(key, m ? sum / m : NaN);
  }
  return yearAvgCache.get(key);
}

// Ends of the coil, by drawn-point index: cap 0 stays on the first day of the
// range, cap 1 sits on the last day drawn so far.
function placeCaps(nPts) {
  if (!nPts) { caps[0].visible = caps[1].visible = false; return; }
  placeCap(caps[0], 0);
  placeCap(caps[1], nPts - 1);
}

function placeCap(cap, pi) {
  cap.position.fromArray(cur.ptPos, pi * 3);
  // The ramp LUT feeds the line's vertex colors raw, so take the cap color
  // through working space too — otherwise the bulb and the line disagree.
  const [r, g, b] = ramp.colorAt(data.temps[ptDay[pi]]);
  cap.material.color.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
  cap.visible = true;
}

// Screen-space size, like the line width: world radius = px * world units per
// pixel at the cap's depth, so the bulbs read the same at any zoom.
const capV = new THREE.Vector3();
function sizeCaps() {
  const h = Math.max(1, stage.clientHeight);
  const px = Math.max(4, state.lineWidth * 2.5);
  let pad = marker.visible ? marker.scale.x : 0;
  for (const cap of caps) {
    if (!cap.visible) continue;
    const unitsPerPx = camera.isOrthographicCamera
      ? (camera.top - camera.bottom) / camera.zoom / h
      : (2 * Math.abs(capV.copy(cap.position).sub(camera.position).dot(fogDir)) * halfFovTan()) / h;
    cap.scale.setScalar(px * unitsPerPx);
    pad = Math.max(pad, cap.scale.x);
  }
  spherePad = pad;
}

function applyPlayhead() {
  if (!lineGeomRef) return;
  const rel = Math.min(Math.max(Math.floor(play.pos) - cur.i0, 0), cur.count - 1);
  lineGeomRef.instanceCount = cur.cumSeg[rel];
  if (points) points.geometry.setDrawRange(0, cur.cumPts[rel]);
  placeCaps(cur.cumPts[rel]);
  const idx = cur.i0 + rel;
  hudY = rel * state.vPerDay;
  if (cur.grid) cur.grid.position.y = hudY;
  if (idx === lastHudIdx) return;
  lastHudIdx = idx;
  const d = data.dateOf(idx);
  hudYear.textContent = d.getUTCFullYear();
  hudDate.textContent = `${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;
  const avg = yearAvg(d.getUTCFullYear());
  hudAvg.textContent = avg === avg ? `avg ${avg.toFixed(1)} °C` : '';
  hudEl.hidden = false;
}

const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');

// Play/Pause runs the playhead; Stop exists only once playback has been
// engaged, and is the one thing that puts the full coil back on screen.
// Reaching a boundary parks the playhead but leaves playback active, so
// reversing the speed slider still un-sticks it.
function updatePlayUI() {
  playBtn.textContent = play.active ? 'Pause' : 'Play';
  stopBtn.hidden = !play.engaged;
}

// Moves the playhead to the far end when it is unplaced (the Infinity sentinel)
// or already parked against the boundary it would travel towards. At speed 0 the
// slider is in its centre dead zone and there is no direction to answer that
// question, so the playhead stays where it is and the coil keeps showing
// everything; the render loop calls this again once a direction exists.
function placePlayhead() {
  if (state.speed === 0) return;
  const iEnd = cur.i0 + cur.count - 1;
  if (play.pos === Infinity) {
    play.pos = state.speed > 0 ? cur.i0 : iEnd;
    return;
  }
  if (state.speed > 0 && Math.floor(play.pos) >= iEnd) play.pos = cur.i0;
  if (state.speed < 0 && Math.floor(play.pos) <= cur.i0) play.pos = iEnd;
}

function togglePlay() {
  if (play.active) {
    play.active = false;
  } else {
    placePlayhead();
    play.active = true;
    play.engaged = true;
  }
  updatePlayUI();
}

function stopPlay() {
  play.active = false;
  play.engaged = false;
  play.pos = Infinity;
  lastHudIdx = -1;
  applyPlayhead();
  updatePlayUI();
}

let pendingRebuild = false;
function scheduleRebuild() {
  if (pendingRebuild) return;
  pendingRebuild = true;
  requestAnimationFrame(() => { pendingRebuild = false; rebuild(); });
}

// --- camera -----------------------------------------------------------------

const center = () => new THREE.Vector3(0, cur.height / 2, 0);
const halfFovTan = () => Math.tan(THREE.MathUtils.degToRad(cameraPersp.fov / 2));
const stageAspect = () => stage.clientWidth / Math.max(1, stage.clientHeight);

let orthoHalfH = 1;
function setOrthoFrustum(halfH) {
  orthoHalfH = halfH;
  const aspect = stageAspect();
  cameraOrtho.top = halfH;
  cameraOrtho.bottom = -halfH;
  cameraOrtho.right = halfH * aspect;
  cameraOrtho.left = -halfH * aspect;
  cameraOrtho.updateProjectionMatrix();
}

const FIT_MARGIN = 1.06;
const fitBasis = new THREE.Matrix4();
const fitRight = new THREE.Vector3();
const fitUp = new THREE.Vector3();
const fitFwd = new THREE.Vector3();
const fitCorner = new THREE.Vector3();
const ORIGIN = new THREE.Vector3();

// Half-extents of the drawn cylinder's bounding box along the camera axes for a
// given view direction (right, up, depth), so framing follows the silhouette.
// A bounding sphere instead of this spends the top view on the coil's height,
// which from up there does not show at all: 250 years of it makes the sphere
// nearly twice the radius that actually has to fit on screen.
function fitExtents(dir) {
  fitBasis.lookAt(dir, ORIGIN, camera.up);
  fitBasis.extractBasis(fitRight, fitUp, fitFwd);
  const c = center();
  let hw = 0, hh = 0, hd = 0;
  for (let i = 0; i < 8; i++) {
    fitCorner
      .set((i & 1) ? cur.fitR : -cur.fitR, (i & 2) ? cur.height : 0, (i & 4) ? cur.fitR : -cur.fitR)
      .sub(c);
    hw = Math.max(hw, Math.abs(fitCorner.dot(fitRight)));
    hh = Math.max(hh, Math.abs(fitCorner.dot(fitUp)));
    hd = Math.max(hd, Math.abs(fitCorner.dot(fitFwd)));
  }
  return { hw, hh, hd };
}

// For ortho the framing lives in the frustum and the distance only has to keep
// near/far sane; a perspective camera has to stand back far enough for whichever
// axis binds, plus half the depth so the near face is inside too.
function fitDistance(dir) {
  const { hw, hh, hd } = fitExtents(dir);
  if (camera.isOrthographicCamera) return (Math.max(hw, hh) + hd) * 3 || 1;
  const t = halfFovTan();
  return Math.max(hh / t, hw / (t * stageAspect())) * FIT_MARGIN + hd;
}

function applyOrthoFit(dir) {
  const { hw, hh } = fitExtents(dir);
  camera.zoom = 1;
  setOrthoFrustum(Math.max(hh, hw / stageAspect()) * FIT_MARGIN || 1);
}

// Keeps the current viewing direction, recenters and refits — so scale/range
// changes never lose the object.
function fitCamera() {
  const c = center();
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0.001);
  dir.normalize();
  const d = fitDistance(dir);
  controls.target.copy(c);
  camera.position.copy(c).addScaledVector(dir, d);
  if (camera.isOrthographicCamera) applyOrthoFit(dir);
}

function viewFrom(dir) {
  const c = center();
  dir.normalize();
  const d = fitDistance(dir);
  if (camera.isOrthographicCamera) applyOrthoFit(dir);
  const end = c.clone().addScaledVector(dir, d);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    camera.position.copy(end);
    controls.target.copy(c);
    return;
  }
  tween = {
    p0: camera.position.clone(), p1: end,
    t0: controls.target.clone(), t1: c,
    start: performance.now(), dur: 450,
  };
}

// Swaps projection while preserving the apparent framing: the visible
// half-height at the target is carried over to the new camera.
function setProjection(mode) {
  const dir = camera.position.clone().sub(controls.target);
  const dist = dir.length() || 1;
  dir.normalize();
  const halfH = camera.isOrthographicCamera
    ? (camera.top - camera.bottom) / 2 / camera.zoom
    : dist * halfFovTan();
  if (mode === 'ortho') {
    camera = cameraOrtho;
    camera.zoom = 1;
    setOrthoFrustum(halfH);
    camera.position.copy(controls.target).addScaledVector(dir, dist);
  } else {
    camera = cameraPersp;
    camera.fov = mode === 'tele' ? 22 : 50;
    camera.position.copy(controls.target).addScaledVector(dir, halfH / halfFovTan());
    camera.updateProjectionMatrix();
  }
  // Near/far are deliberately not set here: updateDepth derives them from the
  // drawn coil every frame, before every render, so anything written now is
  // overwritten before it could be seen.
  controls.object = camera;
  controls.update();
  tween = null;
  state.projection = mode;
}

// +z epsilon keeps the look-down camera non-degenerate AND lands January at
// the top of the screen (screen-up resolves to world -Z).
const viewTop = () => viewFrom(new THREE.Vector3(0, 1, 0.001));
const viewFront = () => viewFrom(new THREE.Vector3(0, 0, 1));

// --- tooltip ----------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let pointerMoved = false;
let pointerXY = { x: 0, y: 0 };

canvas.addEventListener('pointermove', e => {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  pointerXY = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  pointerMoved = true;
});
canvas.addEventListener('pointerleave', hideTooltip);

function hideTooltip() {
  tooltip.hidden = true;
  marker.visible = false;
}

function pickPoint() {
  raycaster.params.Points.threshold = Math.max(cur.maxR * 0.012, 0.001);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(points)[0];
  if (!hit) { hideTooltip(); return; }
  const day = ptDay[hit.index];
  tooltip.textContent = tooltipText(data.dateOf(day), data.temps[day]);
  tooltip.hidden = false;
  const pad = 14;
  tooltip.style.left = `${Math.min(pointerXY.x + pad, stage.clientWidth - tooltip.offsetWidth - 4)}px`;
  tooltip.style.top = `${Math.min(pointerXY.y + pad, stage.clientHeight - tooltip.offsetHeight - 4)}px`;
  marker.position.copy(hit.point);
  marker.visible = true;
}

// --- render loop ------------------------------------------------------------

// Per-frame depth bookkeeping, all from the exact bounding cylinder of the
// DRAWN portion (axis y in [0, hudY]): the axis endpoints' depths along the
// view direction, widened by radius times the direction's horizontal share.
//
// 1. Clip planes: the scene must never get cut by the near plane. Ortho
//    cameras accept a negative near, so the plane is simply pushed behind the
//    geometry. A perspective camera instead gets physically moved back
//    whenever the spiral's nearest point would cross the near plane — the
//    object always stays in front of the camera.
// 2. Fog window: starts at the nearest point (full strength there), state.fade
//    sets how dim the farthest point gets. Anchored to the drawn top, so the
//    window rides the playhead during playback.
const fogDir = new THREE.Vector3();
// Radius of the fattest sphere marker (end caps, hover marker), from the
// previous frame's sizing pass: the clip planes have to clear them too or the
// near plane slices the bulb sitting on the drawn top.
let spherePad = 0;
function updateDepth() {
  fogDir.copy(controls.target).sub(camera.position).normalize();
  const dBase = -camera.position.dot(fogDir);
  const dTop = dBase + hudY * fogDir.y;
  const horiz = Math.hypot(fogDir.x, fogDir.z);

  const radialClip = cur.fitR * horiz + spherePad;
  let clipNear = Math.min(dBase, dTop) - radialClip;
  const clipFar = Math.max(dBase, dTop) + radialClip;
  const span = Math.max(clipFar - clipNear, 0.001);
  if (camera.isPerspectiveCamera) {
    const eps = Math.max(span * 0.01, 0.01);
    if (clipNear < eps) {
      camera.position.addScaledVector(fogDir, clipNear - eps);
      clipNear = eps;
    }
    camera.near = Math.max(clipNear * 0.5, 0.001);
  } else {
    camera.near = clipNear - span * 0.05;
  }
  camera.far = clipFar + span * 0.05 + 1;
  camera.updateProjectionMatrix();

  if (state.fade <= 0.001) { scene.fog.near = 1e8; scene.fog.far = 1e9; return; }
  const radialFog = cur.maxR * horiz;
  const dNear = Math.max(Math.min(dBase, dTop) - radialFog, 0.01);
  const dFar = Math.max(dBase, dTop) + radialFog;
  scene.fog.near = dNear;
  scene.fog.far = dNear + Math.max(dFar - dNear, 0.001) / state.fade;
}

const projV = new THREE.Vector3();
const hudRight = new THREE.Vector3();
const hudEdge = new THREE.Vector3();

// The readout lives inside the coil's empty middle, whose on-screen size swings
// by orders of magnitude between a wide base radius and a tight zoom-out. Text
// is sized from the projected half-width of that hole (rBase is exactly its
// radius, being the radius of the coldest day) so it fills the gap without
// spilling onto the line work. 0.62 leaves the widest line, the four-digit
// year at ~2.05em wide in Georgia, about a fifth of the hole as margin.
// Zoomed far in the hole outgrows the viewport, so the stage caps the size too.
const HUD_MIN_PX = 11, HUD_MAX_STAGE_FRAC = 0.22;
function sizeHud(w, h) {
  hudRight.setFromMatrixColumn(camera.matrixWorld, 0);
  hudEdge.set(0, hudY, 0).addScaledVector(hudRight, state.rBase).project(camera);
  const halfPx = Math.abs(hudEdge.x - projV.x) * w / 2;
  const px = Math.max(Math.min(halfPx * 0.62, h * HUD_MAX_STAGE_FRAC), HUD_MIN_PX);
  hudEl.style.fontSize = `${px.toFixed(1)}px`;
}

function updateLabels() {
  const w = stage.clientWidth, h = stage.clientHeight;
  const camDir = projV.copy(camera.position).sub(controls.target);
  const elev = Math.atan2(camDir.y, Math.hypot(camDir.x, camDir.z));
  labelLayer.classList.toggle('hide-years', elev > 1.25);
  projV.set(0, hudY, 0).project(camera);
  if (projV.z > 1 || projV.z < -1) {
    hudEl.style.display = 'none';
  } else {
    hudEl.style.display = '';
    sizeHud(w, h);
    hudEl.style.transform =
      `translate(-50%,-50%) translate(${((projV.x + 1) / 2) * w}px,${((1 - projV.y) / 2) * h}px)`;
  }
  for (const { el, pos, top } of labels) {
    projV.copy(pos);
    if (top) projV.y = hudY;
    projV.project(camera);
    if (projV.z > 1 || projV.z < -1) { el.style.display = 'none'; continue; }
    el.style.display = '';
    el.style.transform =
      `translate(-50%,-50%) translate(${((projV.x + 1) / 2) * w}px,${((1 - projV.y) / 2) * h}px)`;
  }
}

let lastT = null;

function animate(now) {
  const dt = lastT === null ? 0 : Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  if (play.active && state.speed !== 0) {
    placePlayhead();                 // no-op unless the playhead is still unplaced
    play.pos += dt * state.speed;
    const iEnd = cur.i0 + cur.count - 1;
    // clamp but stay active: reversing the speed slider un-sticks it
    if (play.pos >= iEnd) play.pos = iEnd;
    if (play.pos <= cur.i0) play.pos = cur.i0;
    applyPlayhead();
  }
  if (tween) {
    let u = (now - tween.start) / tween.dur;
    if (u >= 1) { u = 1; }
    const e = 1 - (1 - u) ** 3;
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    if (u === 1) tween = null;
  }
  controls.update();
  updateDepth();
  // Only WebGLRenderer.render refreshes matrixWorld/matrixWorldInverse, and
  // OrbitControls.update does it solely in its zoomToCursor branch (off here).
  // Without this the DOM labels, the HUD sizing and the pick ray would all
  // project through the previous frame's camera while updateDepth has already
  // rewritten the projection matrix, so they visibly lag the line work.
  camera.updateMatrixWorld();
  sizeCaps();
  if (pointerMoved && points) { pointerMoved = false; pickPoint(); }
  updateLabels();
  renderer.render(scene, camera);
}

// --- save as image ----------------------------------------------------------

// Flattens what is on screen into one PNG: the GL frame, then the HTML overlay
// (month/degree/year labels and the center readout) painted on top. The overlay
// is redrawn from each element's own laid-out box and computed style rather
// than from the projection math, so it lands exactly where the DOM put it.
function drawOverlayText(ctx, el, base, k) {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return;
  const text = cs.textTransform === 'uppercase' ? el.textContent.toUpperCase() : el.textContent;
  if (!text) return;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${parseFloat(cs.fontSize) * k}px ${cs.fontFamily}`;
  // Chromium ships canvas letterSpacing; elsewhere the glyphs just sit tighter.
  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = cs.letterSpacing === 'normal'
      ? '0px'
      : `${parseFloat(cs.letterSpacing) * k}px`;
  }
  ctx.fillStyle = cs.color;
  ctx.fillText(text, (r.left - base.left + r.width / 2) * k, (r.top - base.top + r.height / 2) * k);
}

function saveImage() {
  // No preserveDrawingBuffer: the buffer is only readable between this render
  // and the browser's next composite, so the copy has to happen right here.
  renderer.render(scene, camera);
  const w = canvas.width, h = canvas.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#111110';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0);

  const base = stage.getBoundingClientRect();
  const k = w / Math.max(base.width, 1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const el of labelLayer.children) drawOverlayText(ctx, el, base, k);
  // Not `hudEl.hidden`: updateLabels hides the readout with style.display, and
  // getComputedStyle on a CHILD of a display:none parent still reports 'block',
  // so drawOverlayText's own check cannot catch it. Their rects are all zero,
  // which would stamp the year, date and average over the image's top-left.
  if (getComputedStyle(hudEl).display !== 'none') {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = 6 * k;
    for (const el of hudEl.children) drawOverlayText(ctx, el, base, k);
    ctx.shadowBlur = 0;
  }

  out.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `klementinum-${state.element}-${state.y0}-${state.y1}.png`;
    a.click();
    // Revoking in the same task can cancel the download before the browser has
    // read the blob; one turn of the event loop is enough.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, 'image/png');
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  lineMat.resolution.set(w, h);
  cameraPersp.aspect = w / h;
  cameraPersp.updateProjectionMatrix();
  setOrthoFrustum(orthoHalfH);
}

// --- init -------------------------------------------------------------------

data = await loadData();
// Anchors use the global extremes across all three elements, so toggling
// Max/Mean/Min keeps radius and color mappings directly comparable.
tFloor = data.meta.tmin;
ramp = makeRamp(data.meta.tmin, data.meta.tmax);
state.y0 = data.startYear;
state.y1 = data.endYear;
// Element toggle swaps data in place — the user's zoom/pan/rotation survives.
// A false return means a later pick already won the race; that call owns the
// state now, so this one must not write it.
const setElement = async key => {
  if (!await data.setElement(key)) return;
  state.element = key;
  rebuild();
};
const fit = () => { tween = null; fitCamera(); };
const setFade = v => { state.fade = v; };   // applied per frame via fog
const setSpeed = v => { state.speed = v; };
const setLineWidth = v => { lineMat.linewidth = v; };
const setColorGamma = gamma => {
  state.gamma = gamma;
  ramp = makeRamp(data.meta.tmin, data.meta.tmax, gamma);
  setLegend(ramp);
  rebuild();
};

async function reset() {
  Object.assign(state, DEFAULTS, { y0: data.startYear, y1: data.endYear });
  play.active = false;
  play.engaged = false;
  play.pos = Infinity;
  updatePlayUI();
  if (!await data.setElement(state.element)) return;
  ramp = makeRamp(data.meta.tmin, data.meta.tmax, state.gamma);
  setLegend(ramp);
  lineMat.linewidth = state.lineWidth;
  setProjection(state.projection);
  syncControls(state, state.element, state.gamma, state.projection);
  rebuild();
  viewTop();
}

initUI(data, state, {
  rebuild: scheduleRebuild, viewTop, viewFront, fit, setFade, setSpeed, togglePlay,
  stopPlay, saveImage, setElement, setLineWidth, setColorGamma, setProjection, reset, ramp,
});
syncControls(state, state.element, state.gamma, state.projection);
setFreshness(data);
setProjection(state.projection);
resize();
new ResizeObserver(resize).observe(stage);
rebuild();
fitCamera();
renderer.setAnimationLoop(animate);

// The feed check runs alongside the first paint rather than ahead of it, so its
// result lands here. Days are only ever appended, so the view survives: refit
// nothing, and extend the range only if the user was still parked on the end.
data.refreshDone.then(async status => {
  data.refresh = status;
  if (status.updated) {
    const wasAtEnd = state.y1 === data.endYear;
    await data.reload();
    tFloor = data.meta.tmin;
    ramp = makeRamp(data.meta.tmin, data.meta.tmax, state.gamma);
    setLegend(ramp);
    if (wasAtEnd) state.y1 = data.endYear;
    setYearBounds();
    syncControls(state, state.element, state.gamma, state.projection);
    rebuild();
  }
  setFreshness(data);
});

const glInfo = () => {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    version: gl.getParameter(gl.VERSION),
    vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    pixelRatio: renderer.getPixelRatio(),
  };
};
console.info('GL', glInfo());

// dev console handle
window.__dbg = { renderer, scene, controls, state, play, glInfo, cur: () => cur, camera: () => camera };
