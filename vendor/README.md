# Vendored three.js

three.js **r180**, MIT licensed, Copyright 2010-2025 Three.js Authors. Full text
in `LICENSE`; upstream at <https://github.com/mrdoob/three.js>.

Vendored rather than installed so the app needs no build step and no package
manager: `index.html` maps the bare `three` specifier straight at
`vendor/three.module.js` through an import map.

| File | Upstream path |
| --- | --- |
| `three.module.js`, `three.core.js` | `build/` |
| `OrbitControls.js` | `examples/jsm/controls/` |
| `lines/LineSegments2.js`, `lines/LineSegmentsGeometry.js`, `lines/LineMaterial.js` | `examples/jsm/lines/` |

## Local modification

The three files under `lines/` are **modified**. Upstream `LineSegmentsGeometry`
carries three colour floats per endpoint; these carry four, so the coil can hand
the shader a per-vertex alpha alongside rgb. Every changed hunk is marked
`LOCAL MOD (klementinum-trdelnik)`:

- `LineSegmentsGeometry.js` — `setColors` packs rgba, stride 8
- `LineMaterial.js` — `instanceColorStart/End` become `vec4`, alpha reaches `gl_FragColor`

Re-vendoring from a newer three.js means re-applying those hunks. Nothing else
in this directory is patched.

The alpha channel is plumbed through but currently always 1: depth dimming
happens through scene fog instead (see `src/app.js`, `updateDepth`).
