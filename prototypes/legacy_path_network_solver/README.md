# Legacy: automated path-network / active-path snap solvers

This directory holds three fully-automated "packing → crease network" solvers
that were live features earlier in this project's history but were retired
(their UI trigger buttons removed) the moment the manual, interactive **Tiling
Editor** shipped (commit `474cc8e`, "tiling editor + milp seeding"). They are
kept here as a frozen reference, not as working code -- see "Why they don't
run" below.

## What each one was

- **`backend/app/core/active_paths.py`** + **`api/snap.py`** /
  **`services/snap_service.py`** / **`schemas/snap.py`** -- the first
  automated approach: detect "active" (tangent/near-tangent) flap-to-flap
  paths already implied by a solved packing and snap the tree's edge lengths
  to match them exactly. Triggered by a "Snap paths" button. The frontend
  half of this idea (`frontend/src/geometry/activePaths.ts`) is **NOT** here
  -- it's still live, used purely for rendering the dashed active-path
  overlay in the Packing Editor, independent of this backend snap action.

- **`backend/app/core/path_network*.py`** + **`spectral.py`** +
  **`api/path_network.py`** / **`services/path_network_service.py`** /
  **`schemas/path_network.py`** -- a much more elaborate successor: a relaxed
  NLP (continuation/annealing + basin-hopping restarts) that tries to derive
  an entire crease *network* (not just direct paths) from a packing in one
  shot, originally matched against a CWKS spectral heat-kernel signature
  (`spectral.py` -- itself abandoned even before the whole feature was, see
  the comment in `path_network_vars.py`'s docstring) and later against a
  simpler direct-path/degree-3-vertex count objective. Triggered by a "Snap
  path network" button.

- **`frontend/src/state/store.ts`'s old `solveTiling` action** (already just
  deleted, not moved here as a file since it was a few dozen lines inside an
  otherwise-live file) -- a third variant, calling the *same*
  `/api/tiling-snap` endpoint the live Tiling Editor's `seedTilingGraph` still
  uses internally for MILP-suggested interior paths, but as a direct
  one-shot "solve the whole tiling automatically" trigger with no manual
  editing step. Also had zero UI call site by the time of this cleanup.

## Why they're gone

All three tried to fully automate the same thing the Tiling Editor now does
*with the user in the loop*: turn a packing into a crease pattern. Once the
Tiling Editor could seed a starting layout (via the still-live
`/api/tiling-snap` MILP candidate suggestions) and let the user manually
build/drag/lock the rest with live constraint-solving, none of these
one-shot automated solvers had a reason to stay wired into the UI. Their
settings-modal sections and store actions were quietly left in place for a
while after their buttons disappeared -- straightforward config-following-
the-feature-out-the-door drift, not an intentional decision to keep them
"in reserve."

## Why they don't run as-is

These files were moved out of the live `backend/app` package with their
internal `from app.core...` / `from app.schemas...`-style imports left
untouched, exactly like the standalone scripts already in the parent
`prototypes/` directory (which reference modules that don't exist in this
repo at all, e.g. `src.engine.math225_core`). If you want to resurrect any
of this, you'll need to either drop it back into `backend/app` in the same
relative layout, or rewrite the imports for wherever it lands.

## If you want to bring one back

- The **active-paths snap** is the simplest and most self-contained --
  `active_paths.py`'s core algorithm has essentially zero cross-dependencies
  on the other two.
- **`path_network*.py`** is the most complete/tunable but also the most
  complex; its hyperparameters (`path_network_*`, moved out of
  `backend/app/schemas/hyperparams.py` and `frontend/src/types/hyperparams.ts`
  in the same cleanup) would need to be re-added alongside it.
- Either way, re-wiring means: put the file(s) back, re-add the
  `app.include_router(...)` line in `backend/app/main.py`, and add a button
  back to a toolbar component that calls the corresponding frontend store
  action (also deleted -- check git history around this README's own commit
  for the exact removed code).
