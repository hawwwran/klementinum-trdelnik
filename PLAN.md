# Klementinum Trdelnik — plan

3D web visualization of daily temperatures measured at Prague Klementinum
(station 0-203-0-11514, CHMI open data), 1775-01-01 → present. Historical CSVs
(through the last full year) are merged with the CHMI "recent" feed, which
carries the running year day by day — the current incomplete year shows as a
partial final turn.

## Concept

A helix in 3D space, one revolution per calendar year:

- **angle** = position within the year (Jan 1 at 12 o'clock, months clockwise
  when viewed from above; leap years handled — each year is exactly one turn)
- **height (y)** = time; oldest day at the bottom, newest at the top
- **radius** = temperature; radius = rBase + (warp(T) − warp(T_min)) ·
  unitsPerDeg, where T_min is the all-time minimum across all three elements
  (−27.6 °C, TMI 1 Mar 1785) — the coldest day ever sits exactly on the "base
  circle" of radius rBase, a user setting that spreads the spiral onto larger
  circles; anchors are global so Max/Mean/Min stay directly comparable
- **color** = temperature gradient anchored to the all-time dataset extremes:
  minimum ever = deep blue `#00008b` through blue `#0000ff` to white at 0 °C,
  then yellow → orange → red → deep red `#8b0000` at the maximum ever
  (39.7 °C, 28 Jun 2026); stops evenly spaced per arm, interpolated in OKLab.
  Global anchors: coloring never rescales when toggling elements or narrowing
  the year range.
- **depth dim** = fog-based depth cue: the farther a segment is from the view
  plane, the dimmer it gets. The fog window is retuned every frame from the
  exact bounding cylinder of the *drawn* portion (so it rides the playhead
  during playback), with the nearest point always at full strength; the
  "Depth dim" slider sets how dim the farthest point gets, 0 disables. From
  the side the coil reads roughly even; from the top the deep past visibly
  recedes. Implemented with THREE.Fog toward the background color —
  projection-aware for free.

## Controls (user-specified)

- **Reading**: Max / Mean / Min daily temperature (CHMI elements TMA, T with
  TIMEFUNC=AVG, TMI), lazily fetched and cached per element. The radius anchor
  is the global minimum across all elements, so the base circle and scale hold
  steady across the toggle.
- **Year range**: dual slider, start thumb from the left, end thumb from the
  right, 1775–present.
- **Rotation**: OrbitControls (drag to rotate, wheel to zoom). Default camera:
  top view. Buttons: **Top**, **Front** (smooth tween, instant when
  `prefers-reduced-motion`) and **Fit**. Framing measures the drawn cylinder's
  bounding box along the camera axes, so it fills the window from any direction;
  a bounding sphere would leave the top view at ~40 % of the width, since 250
  years of coil height does not show from up there.
- **Resolution**:
  - *base radius* — radius of the base circle where the coldest measured day
    sits (linear slider)
  - *units per °C* — radial scale (log slider)
  - *curve* — radial exponent (log slider): temperatures are warped by
    sign(T)·|T|^p around 0 °C before the radius mapping, renormalized so the
    all-time extreme keeps its linear radius; p > 1 pushes extremes
    disproportionally outward, p < 1 compresses them. The °C rings follow the
    same warp, so the axis stays honest.
  - *units per day* — vertical scale (log slider)
  - *line width* — screen-space px (Three.js fat lines: LineSegments2 +
    LineMaterial, vendored; native WebGL lines are stuck at 1 px)
  - *depth dim* — strength of the fog depth cue (see Concept)
- **Color mode**: Linear / Exp — Exp applies gamma 2.2 per arm, keeping
  mid-range temperatures near white and spending color resolution on extremes.
- **Projection**: Persp (50°) / Tele (22°) / Ortho. Switching preserves the
  apparent framing by carrying the visible half-height at the target over to
  the new camera. Ortho is the boot default.
- **Reset to defaults**: one button restores the neutral configuration —
  Max reading, full year range, linear curve, linear color, ortho projection,
  top view, default scales / line width / depth dim / play speed, playback
  stopped at the range end.
- The camera is never moved by control changes — zoom/pan/rotation survive
  year-range, scale, element, and color changes, so you can zoom into a spot
  and watch it change. Framing is explicit: the **Fit** button refits the
  current rotation to the spiral's bounds (and Top / Front / Reset frame from
  their own directions).

## Playback

Play button + bidirectional speed slider: center = 0, right half forward and
left half reverse, each log-scaled 30–20 000 days/second with a snap-to-zero
dead zone at the center. Geometry stays fully built; the playhead only sets
the instanced-segment draw count, so animation costs nothing per frame.

Playback never stops on its own: reaching the range end (or start, in
reverse) parks the playhead there but stays active — flipping the speed sign
un-sticks it. Play/Pause runs and holds; a separate **Stop**, which appears only
once playback has been engaged, is the one thing that puts the whole coil back.
Pressing Play while parked against a boundary in the travel direction restarts
from the opposite end. At speed 0 (the slider's dead zone) there is no direction
to answer "which end", so Play leaves the coil showing everything and the
playhead takes its place the moment a sign exists.

Internally the playhead carries an `Infinity` sentinel for "unplaced", which is
what makes "stopped" mean "draw everything" through a year-range change. Clamping
it into the new range on rebuild would pin the coil to the previous range's last
day, and widening the years again would then draw nothing new.

A HUD anchored at the spiral's center rides the drawn top: current YEAR
(large), D.M. (smaller), and the average temperature of that whole year for
the active element (constant while the year draws, cached per element+year).
Its type scales every frame to the projected width of the coil's empty middle
(the base radius), so it fills the hole at any zoom instead of sitting at one
fixed size, floored and capped against the stage height.

## Data freshness

The page is current on every load: `src/data.js` calls `GET api/refresh.php`
before it reads `data/meta.json`, and that endpoint runs the incremental tail
update. Only the tail can move, which is what keeps this cheap:

- the historical CSVs cover everything up to `meta.hist_end` and only
  `prepare_data.py` ever writes those days
- the CHMI "recent" feed publishes one ~36 KB JSON per month, and from day to
  day only the running month's file changes; every file carries an ETag, so
  "anything new?" is a conditional GET that answers 304 with no body
- days after `hist_end` are re-merged from the feed each time, so the revision
  of a preliminary value lands on a later load, not just brand new days
- new days are appended to the `.i16` grid; binaries and `meta.json` are
  rewritten only when a value actually differs

A check is ~0.2 s (all months in one `curl_multi` batch) and is throttled to one
per 5 minutes. `php tools/refresh.php --force` skips the throttle; the HTTP
endpoint deliberately does not accept `force`, because forcing costs an outbound
fetch per hit.

Concurrency and crash safety, since PHP hosting means N unrelated workers:

- `flock(LOCK_EX | LOCK_NB)` on `data/refresh.lock`: one worker updates, the rest
  answer "refresh already running" instead of queueing up behind the files
- every file is written to `.tmp` and renamed into place, so a fetch never sees a
  half-written binary
- binaries are written before `meta.json`, so a load that lands mid-update sees
  an `.i16` longer than `meta.days` (harmless, the tail is ignored) rather than a
  `meta.json` promising days the binary does not have
- element arrays are never materialized in PHP: days are patched by byte offset
  and the extremes rescan reads 8192 values at a time

The refresh needs the server side: opendata.chmi.cz sends no
`Access-Control-Allow-Origin`, so the browser cannot poll the feed itself. Serve
the app from anything static and the endpoint 404s, the app draws whatever is in
`data/`, and the footer says the live update is unavailable — same for a host
without outbound access, or a feed slower than the 6 s client timeout.

`api/diag.php` probes a fresh host (PHP version, curl/openssl, `data/`
writability, feed reachability); it is a deploy-time tool, not part of the app.

## Extras that make it readable

- Bulbs on both ends of the drawn coil: the first day of the range and the last
  day drawn (the top one rides the playhead). Each takes the color of its own
  day, is sized in screen space like the line width, and ignores fog so the far
  end stays legible. The clip planes carry a pad for them, otherwise the near
  plane slices the bulb sitting on the drawn top.
- Reference rings every 10 °C, 0 °C ring emphasized, with °C labels, and month
  labels around the rim. These ride the **drawn top** rather than sitting at
  y = 0: from the default look-down view the base of the coil is the far end,
  where the depth fog erases them. Riding the playhead also lines the month names
  up with the day the HUD is reporting. The ring materials opt out of fog, since a
  steep view still puts the far half of a ring deep in the window.
- Central spine with decade tick labels (tick step auto-picked so ≤ ~15 labels).
- Hover tooltip: raycast to the nearest day → date + temperature.
- Readings panel: hottest / coldest day (with dates) and mean for the selected
  range, plus missing-day count.
- Color legend bar generated from the same ramp.
- **Save as image**: the GL frame copied into a 2D canvas, then the HTML overlay
  (month, °C and year labels, and the center readout) painted on top from each
  element's own laid-out box and computed style, so it lands where the DOM put it.
  Downloaded as `klementinum-<element>-<y0>-<y1>.png`.

## Architecture

Vanilla ES modules + vendored Three.js (pinned r180, `vendor/`), no build step.
The only server-side code is the data refresh, in PHP, so the whole thing runs on
commodity PHP hosting. Locally, `php -S localhost:8000 tools/router.php` mirrors
that setup and adds `Cache-Control: no-cache` so reloads never mix stale and
fresh modules.

```
index.html          layout, importmap (three → vendor/three.module.js)
style.css           dark instrument-panel UI
src/app.js          scene, cameras, rebuild/playback orchestration, fog,
                    labels, HUD, tooltip
src/data.js         refresh kicked off alongside first paint, meta + lazy
                    per-element binary decode, per-day year-fraction precompute
src/spiral.js       radius mapping + topology (colours, valid days, playback
                    cumulative counts, range stats) + position refill
src/colors.js       OKLab multi-stop gradient, LUT, CSS gradient for legend
src/ui.js           dual slider, log/bidirectional sliders, segmented
                    controls, stats/legend DOM, control sync for Reset
api/refresh.php     endpoint the app calls while it draws
api/update.php      the tail update: merge, extremes rescan, atomic writes
api/chmi.php        recent-feed fetch (conditional GET, curl_multi) + parse
api/diag.php        one-off host probe, 404 unless DIAG_KEY is set
tools/prepare_data.py   raw CSVs → data/*.i16 + meta.json (local, once a year)
tools/refresh.php   CLI face of the tail update, for cron
tools/router.php    dev server router: no-cache statics, runs api/*.php
tools/dev-browser.sh    Chromium with per-domain 3D blocking disabled
.htaccess           MIME for .i16, no-cache for data, hides tools/ and raw CSVs
vendor/lines/       fat-line addon, LOCAL MOD: rgba instance colors
data/raw/           original CHMI CSVs (kept for provenance, not deployed)
data/{tma,tavg,tmi}.i16  Int16 LE, temp × 10, −32768 = missing (~180 KB each)
data/meta.json      shared day grid, hist_end, per-element extremes
data/recent-state.json  per-month ETags + last check time, for the refresh
```

### Rendering decisions

- Fat lines (`LineSegments2`, one instanced quad per day-to-day segment,
  ~92 k segments): adjustable pixel width; missing days break the line
  naturally by just not emitting a segment. `vendor/lines/` carries a LOCAL
  MOD (rgba instance colors + `vLineAlpha` varying) so per-vertex alpha is
  available; it is constant 1 today — depth dimming goes through fog instead.
- Vertex colors from a precomputed 1024-entry ramp LUT.
- Invisible `THREE.Points` sharing the day positions for tooltip raycasting
  (points raycast is cheap and gives nearest-day semantics directly).
- Rebuilds are split so a Scale-slider scrub is cheap: colours, the valid-day
  index and the draw cursors depend only on element + colour ramp + year range and
  are cached on exactly that key, while the position buffers are refilled in place
  into arrays the app owns. Rebuilding both wholesale meant ~7 MB of fresh typed
  arrays per frame at 60 rebuilds a second. Rebuilds are still coalesced per
  animation frame, and the coil's mesh and geometry outlive them.
- Labels and the playback HUD are plain HTML divs projected to screen space
  each frame (a few dozen — no need for CSS2DRenderer).
- **Never clipped by the near plane**: clip planes track the drawn geometry
  every frame. Ortho uses a negative near when the spiral grows past the
  camera plane; a perspective camera is instead pushed back so the object
  always stays fully in front of it (side effect: you can't dolly inside the
  spiral in perspective).
- WebGL context lifecycle, the part that makes development bearable: Chromium
  keeps ~16 live contexts browser-wide and evicts the oldest, and blocks a domain
  from 3D APIs for a few seconds after it attributes context losses to it, so a
  reload-heavy session runs out of contexts. Therefore:
  - boot retries context creation with a backoff (0 / 0.4 / 1.2 / 3 s), since the
    domain block clears by itself, and only then shows a failure panel — with a
    Retry button, and a different message depending on whether the browser has
    *any* working WebGL (blocklisted driver) or is only refusing this page
  - `pagehide` calls `forceContextLoss()` then `dispose()`, handing the context
    back immediately instead of waiting for the canvas to be collected. This is a
    synthetic loss via `WEBGL_lose_context`, not a GPU reset, so it is not the
    kind of event that gets a domain blocked (an earlier note here claimed
    otherwise; a leaked context per reload is the thing that actually hurts)
  - `preventDefault()` on `webglcontextlost` lets the browser restore, and
    `webglcontextrestored` rebuilds the geometry — an evicted context recovers
    without a reload
  - `tools/dev-browser.sh` launches a Chromium-family browser with
    `--disable-domain-blocking-for-3d-apis` on a throwaway profile
  - `?dpr=1` caps the pixel ratio, and the GL vendor/renderer is logged at boot
    (`window.__dbg.glInfo()`), which is the first thing to know when contexts die
- `window.__dbg` exposes renderer/scene/controls/state/play/camera for
  console debugging.

### Layout

Two columns: a 300 px control panel and the stage, both full viewport height
(`html, body { height: 100% }` plus flex, never `vh` — mobile browsers move the
goalposts on `vh`). Under 720 px the two stack, stage first at 60 % of the height
and the panel scrolling in the rest; the panel has to be told to share the column
(`flex: 1 1 40%; min-height: 0`), because at its natural ~1500 px it would take
the whole viewport and leave the stage zero pixels tall. The canvas carries
`touch-action: none` so a drag rotates instead of scrolling the page.

### Design tokens

Dark-only scene (committed single look). Chart chrome from the dataviz
reference palette (dark surface `#1a1a19`, muted ink `#898781`, gridline
`#2c2c2a`). Data gradient: `#00008b` → `#0000ff` → `#ffffff` (0 °C) →
`#ffff00` → `#ff8c00` → `#ff0000` → `#8b0000`, anchored to all-time extremes
(see Concept). UI identity accent: brass `#c99a4b` (Klementinum = baroque
observatory; instrument-panel look) — used only for controls, never for data.
Title and HUD year in a serif stack (archive/1775 flavor); everything else
system sans.

## Verification

Serve locally, drive with Playwright: screenshot top and front views, check
console for errors, exercise the sliders. For the refresh path, roll the local
grid back a few days (truncate the `.i16` tails, lower `meta.end`/`meta.days`,
delete `data/recent-state.json`) and reload: the footer should report the days
it added, and the result should match a full `prepare_data.py` rebuild.

## Out of scope (possible later)

- Second-station comparison (same file format, any CHMI station id)
- Marking record days directly in the 3D scene
- Exporting playback as video
