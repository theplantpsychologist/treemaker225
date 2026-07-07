# treemaker225

A treemaker-like algorithm but for 22.5 crease patterns.

A browser-based tool for designing uniaxial origami bases: sketch a shape/edge
tree on one canvas, then pack the resulting flaps onto a unit square via a
constrained nonlinear solver on the other. See
`.claude/plans/dynamic-orbiting-canyon.md` for the full design.

## Features

- **Tree editor**: click to place/select nodes, click empty space to add a
  child (edge length = on-screen distance), drag a node to rigidly translate
  its whole subtree. Leaf color reflects any active packing constraint.
  Clicking a leaf selects its edge (opens the inspector) and arms it for
  further children; clicking a branch/root only arms it for children.
- **Packing shapes**: circle, square, hexagon, octagon, or dodecagon,
  selectable per session — changes both the on-screen flap shape and the
  solver's separating-axis constraint basis.
- **Packing solver**: two-phase scipy SLSQP solve — many random-restart
  circle-packings, then the best ones refined into the chosen shape via a
  smooth-max separating-axis constraint over that shape's face-normal
  directions (skipped entirely for circles). Internal (non-leaf) node
  positions are fit afterward via least-squares so rivers can be drawn.
  Every solve after the first automatically seeds from the current packing
  instead of starting from random restarts.
- **Packing editor**: drag a flap to reposition it; once selected, drag
  anywhere along its boundary to resize (writes back to the tree edge
  length); drag a river's handle to change its width. A scale slider lets
  you nudge the whole packing's scale up/down around the last solve. Live
  overlap detection draws a red dashed line between any pair of flaps closer
  than their required separation. The canvas greys out with a banner when
  the tree's topology has changed since the last solve.
- **Rivers**: real polygon geometry — each river is the union of everything
  downstream of it, expanded outward by its own width, with the original
  union subtracted back out to leave the visible band (via `clipper2-ts`).
  Rivers can be disconnected or holed when their contents are far apart.
- **Constraints**: pin a flap to the symmetry line (book = mirror across
  `x=0.5`, diagonal = mirror across `y=x`), pair two flaps across the line
  (their lengths average and mirror live), pin a flap to a paper edge or
  corner (arm "Pin to edge/corner" in the inspector, then click a highlighted
  handle on the packing square — pinning two flaps to the same corner is
  rejected). All constraints apply instantly and are respected by the next
  solve.
- **Pan/zoom**: mouse wheel to zoom, drag empty space to pan, on both the
  tree and packing canvases. The two panes are separated by a draggable
  divider.
- **Undo/redo**: every discrete edit (add a node, drag a flap, change a
  constraint, solve, import) is a single undo step; a "Start Over" button
  clears the session.
- **Save/load**: export/import the full session (tree, constraints,
  hyperparameters, packing) as a JSON file.

## Structure

- `backend/` — FastAPI service that runs the scipy-based packing solver.
- `frontend/` — React + TypeScript + Vite single-page app (plain SVG rendering).

## Running locally

Two processes, run in separate terminals.

### Backend

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Health check: `curl http://localhost:8000/api/health`

### Frontend

```sh
cd frontend
npm install
npm run dev
```

Open the printed local URL (default `http://localhost:5173`). The frontend
expects the backend at `http://localhost:8000`.

## Tests

```sh
cd backend
source .venv/bin/activate
pytest
```
