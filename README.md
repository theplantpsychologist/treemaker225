# treemaker225

A treemaker-like algorithm but for 22.5 crease patterns.

A browser-based tool for designing uniaxial origami bases: sketch a shape/edge
tree on one canvas, then pack the resulting flaps as octagons onto a unit
square via a constrained nonlinear solver on the other. See
`.claude/plans/dynamic-orbiting-canyon.md` for the full design.

## Features

- **Tree editor**: click to place/select nodes, click empty space to add a
  child (edge length = on-screen distance), drag a node to rigidly translate
  its whole subtree. Leaf color reflects any active packing constraint.
- **Packing solver**: two-phase scipy SLSQP solve — many random-restart
  circle-packings, then the best ones refined into octagon packings via a
  smooth-max separating-axis constraint over the octagon's 8 face-normal
  directions. Internal (non-leaf) node positions are fit afterward via
  least-squares so rivers can be drawn.
- **Packing editor**: drag a flap to reposition it, drag its handle to resize
  (writes back to the tree edge length), drag a river's handle to change its
  width. Live overlap detection draws a red dashed line between any pair of
  flaps closer than their required octagon separation.
- **Constraints**: pin a flap to the symmetry line (book = mirror across
  `x=0.5`, diagonal = mirror across `y=x`), pair two flaps across the line
  (their lengths average and mirror live), pin a flap to a paper edge or
  corner (click a handle on the packing square). All constraints apply
  instantly and are respected by the next solve.
- **Solve from current positions**: re-run the solver seeded from the
  packing's current (possibly manually-edited) layout instead of random
  restarts.
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
