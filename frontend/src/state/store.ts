import { create } from 'zustand'
import { API_BASE, fetchPathNetworkSnap, fetchSnapPaths, fetchSolve } from '../api/client'
import type { PathNetworkResponse } from '../types/pathNetwork'
import type { ConstraintsState, CornerId, EdgeSide, LeafConstraint, SymmetryMode } from '../types/constraints'
import { DEFAULT_CONSTRAINTS, NO_LEAF_CONSTRAINT } from '../types/constraints'
import type { HyperparamsState } from '../types/hyperparams'
import { DEFAULT_HYPERPARAMS } from '../types/hyperparams'
import type { PackingState } from '../types/solve'
import { toTreeIn } from '../types/tree'
import type { TreeState } from '../types/tree'
import { canonicalizeRoot, getLeaves } from '../geometry/treeGeometry'
import { backfillMissingPositions, computeNaiveInitialization, naiveScale } from '../geometry/naiveInit'
import {
  collectResolvedPoints,
  findAnyCollision,
  findPointCollision,
  isFullyFixedBySymmetryBoundary,
  resolveLeafConstraint,
} from '../geometry/constraintResolution'
import {
  addChildNode,
  createRootNode,
  deleteNode as deleteNodeAction,
  dragNodeTo,
  setEdgeLength as setEdgeLengthAction,
} from './actions/treeActions'
import {
  boundaryEquals,
  mirrorBoundary,
  pruneInvalidEqualPairs,
  pruneLeafConstraint,
  withClearedBoundary,
  withClearedEqual,
  withClearedLock,
  withClearedSymmetry,
  withEqual,
  withLocked,
  withPair,
  withPinCorner,
  withPinEdge,
  withPinSymmetry,
  withSymmetryMode,
} from './actions/constraintActions'
import { moveFlapPositions } from './actions/packingActions'
import type { SavedSession } from '../types/session'
import { parseSavedSession } from '../types/session'
import { downloadJson } from '../utils/download'
import type { HistorySnapshot } from './history'
import { HISTORY_LIMIT, snapshot } from './history'

interface AppState {
  tree: TreeState
  activeParentId: string | null
  constraints: ConstraintsState
  selectedEdgeId: string | null
  pairingSourceId: string | null
  equalSourceId: string | null
  pinTargetMode: 'edge' | 'corner' | null
  constraintError: string | null
  hyperparams: HyperparamsState
  clipToSquare: boolean
  packing: PackingState | null
  lastSolvedScale: number | null
  solving: boolean
  solveError: string | null
  uiError: string | null
  undoStack: HistorySnapshot[]
  redoStack: HistorySnapshot[]
  /** The most recent path-network solve's selected direct paths/legs, for
   * the tiling canvas's view-only rendering. Transient (not part of undo/
   * redo snapshots, like solveError/uiError) -- it's a display artifact of
   * the last snap, not tree/packing state. */
  pathNetworkResult: PathNetworkResponse | null

  pushUndoSnapshot: () => void
  undo: () => void
  redo: () => void
  startOver: () => void

  selectTreeNode: (id: string) => void
  clearSelection: () => void
  createRootAt: (x: number, y: number) => void
  addChildAt: (parentId: string, x: number, y: number) => void
  initializePacking: () => void
  deleteActiveNode: () => void
  deleteNodeById: (id: string) => void
  moveNode: (id: string, x: number, y: number) => void
  setEdgeLength: (id: string, length: number) => void
  syncEqualLength: (id: string) => void

  selectEdge: (id: string | null) => void
  setSymmetryMode: (mode: SymmetryMode) => void
  armPairing: (leafId: string) => void
  cancelPairing: () => void
  pairFlaps: (aId: string, bId: string) => void
  armEqual: (id: string) => void
  cancelEqual: () => void
  setEqualPair: (aId: string, bId: string) => void
  clearEqualConstraint: (id: string) => void
  armPinTarget: (mode: 'edge' | 'corner') => void
  cancelPinTarget: () => void
  pinToSymmetry: (leafId: string) => void
  pinToEdge: (leafId: string, edge: EdgeSide) => void
  pinToCorner: (leafId: string, corner: CornerId) => void
  clearSymmetryConstraint: (leafId: string) => void
  clearBoundaryConstraint: (leafId: string) => void
  toggleLock: (leafId: string) => void
  setLockedPosition: (leafId: string, x: number, y: number) => void
  clearConstraintError: () => void
  moveFlap: (id: string, x: number, y: number) => void
  snapFlap: (id: string) => void
  setPackingScale: (scale: number) => void

  setHyperparams: (hyperparams: Partial<HyperparamsState>) => void
  setClipToSquare: (value: boolean) => void
  clearUiError: () => void
  runSolve: () => Promise<void>
  snapActivePaths: () => Promise<void>
  snapPathNetwork: () => Promise<void>

  exportSession: () => void
  importSession: (data: unknown) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  tree: { rootId: null, nodes: {} },
  activeParentId: null,
  constraints: DEFAULT_CONSTRAINTS,
  selectedEdgeId: null,
  pairingSourceId: null,
  equalSourceId: null,
  pinTargetMode: null,
  constraintError: null,
  hyperparams: DEFAULT_HYPERPARAMS,
  clipToSquare: true,
  packing: null,
  lastSolvedScale: null,
  solving: false,
  solveError: null,
  uiError: null,
  undoStack: [],
  redoStack: [],
  pathNetworkResult: null,

  pushUndoSnapshot: () => {
    const state = get()
    const undoStack = [...state.undoStack, snapshot(state)].slice(-HISTORY_LIMIT)
    set({ undoStack, redoStack: [] })
  },

  undo: () => {
    const state = get()
    if (state.undoStack.length === 0) return
    const prev = state.undoStack[state.undoStack.length - 1]
    set({
      ...prev,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, snapshot(state)],
      activeParentId: null,
      selectedEdgeId: null,
      pairingSourceId: null,
      equalSourceId: null,
      pinTargetMode: null,
      constraintError: null,
    })
  },

  redo: () => {
    const state = get()
    if (state.redoStack.length === 0) return
    const next = state.redoStack[state.redoStack.length - 1]
    set({
      ...next,
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, snapshot(state)],
      activeParentId: null,
      selectedEdgeId: null,
      pairingSourceId: null,
      equalSourceId: null,
      pinTargetMode: null,
      constraintError: null,
    })
  },

  startOver: () => {
    const state = get()
    const undoStack = [...state.undoStack, snapshot(state)].slice(-HISTORY_LIMIT)
    set({
      tree: { rootId: null, nodes: {} },
      constraints: DEFAULT_CONSTRAINTS,
      packing: null,
      lastSolvedScale: null,
      activeParentId: null,
      selectedEdgeId: null,
      pairingSourceId: null,
      equalSourceId: null,
      pinTargetMode: null,
      constraintError: null,
      solveError: null,
      undoStack,
      redoStack: [],
    })
  },

  selectTreeNode: (id) => {
    const node = get().tree.nodes[id]
    if (!node) return
    const isRoot = node.parentId === null
    const isLeaf = !isRoot && node.children.length === 0
    if (isLeaf) {
      set({ selectedEdgeId: id, activeParentId: id })
    } else {
      set({ selectedEdgeId: null, activeParentId: id })
    }
  },

  clearSelection: () =>
    set({ selectedEdgeId: null, activeParentId: null, pinTargetMode: null, equalSourceId: null }),

  createRootAt: (x, y) => {
    get().pushUndoSnapshot()
    const tree = createRootNode(x, y)
    set({ tree, activeParentId: tree.rootId, selectedEdgeId: null })
  },

  addChildAt: (parentId, x, y) => {
    get().pushUndoSnapshot()
    const tree = canonicalizeRoot(addChildNode(get().tree, parentId, x, y).tree)
    // The parent just gained a child, so if it was a leaf carrying a
    // constraint, that constraint no longer makes sense — prune it rather
    // than leave a dangling reference the backend would reject at solve time.
    const { constraints: prunedConstraints, warning } = pruneLeafConstraint(get().constraints, parentId)
    const constraints = pruneInvalidEqualPairs(tree, prunedConstraints)
    // Maintain the packing-position invariant once a packing exists (from
    // Initialize or a real solve): every tree id always has a packing
    // position, so `initFrom:'current'` stays viable and no grey-out/stale
    // window ever opens for an ordinary add. Before that, packing stays
    // null — the toolbar only offers "Initialize" until the user asks for
    // a layout (see `initializePacking`).
    const prevPacking = get().packing
    const packing =
      prevPacking == null
        ? null
        : {
            ...prevPacking,
            positions: backfillMissingPositions(tree, prevPacking.positions),
            scale: prevPacking.diagnostics.kind === 'naive' ? naiveScale(tree) : prevPacking.scale,
          }
    set({ tree, constraints, packing, uiError: warning ?? get().uiError })
  },

  initializePacking: () => {
    const state = get()
    if (!state.tree.rootId) return
    get().pushUndoSnapshot()
    const naive = computeNaiveInitialization(state.tree)
    set({
      packing: { ...naive, diagnostics: { kind: 'naive' } },
      constraints: DEFAULT_CONSTRAINTS,
      lastSolvedScale: null,
      pairingSourceId: null,
      equalSourceId: null,
      pinTargetMode: null,
      constraintError: null,
      uiError: null,
    })
  },

  deleteActiveNode: () => {
    const id = get().activeParentId
    if (!id) return
    get().deleteNodeById(id)
  },

  /** Shared by the tree editor's Backspace/Delete keybind (targeting
   * `activeParentId`) and the Inspector's delete-flap button (targeting
   * `selectedEdgeId`) — same underlying delete/prune logic either way. */
  deleteNodeById: (id) => {
    const state = get()
    const result = deleteNodeAction(state.tree, id)
    if (!result) {
      set({ uiError: "Can't delete a branch node — delete its children first." })
      return
    }
    get().pushUndoSnapshot()
    const { constraints: prunedConstraints } = pruneLeafConstraint(state.constraints, result.deletedId)
    const tree = canonicalizeRoot(result.tree)
    const constraints = pruneInvalidEqualPairs(tree, prunedConstraints)
    // Prune the deleted id from packing.positions in the same set() call as
    // the tree mutation — tree and packing update atomically, so
    // isPackingStale never observes an intermediate mismatched frame, and
    // deleting never opens a warning/grey-out window (see decision #5).
    let packing = state.packing
    if (packing != null) {
      if (tree.rootId == null) {
        packing = null
      } else {
        const { [result.deletedId]: _dropped, ...positions } = packing.positions
        packing = {
          ...packing,
          positions,
          scale: packing.diagnostics.kind === 'naive' ? naiveScale(tree) : packing.scale,
        }
      }
    }
    set({
      tree,
      constraints,
      packing,
      activeParentId: null,
      selectedEdgeId: null,
      equalSourceId: null,
      uiError: null,
    })
  },

  moveNode: (id, x, y) => {
    set({ tree: dragNodeTo(get().tree, id, x, y) })
    get().syncEqualLength(id)
  },

  setEdgeLength: (id, length) => {
    set({ tree: setEdgeLengthAction(get().tree, id, length) })
    get().syncEqualLength(id)
  },

  /** Whenever a node's length changes (from either canvas), if it has an
   * equal-size partner (see `types/constraints.ts`'s `equalPairs` — either
   * two flaps or two rivers), immediately set both to their average, with
   * an epsilon guard to avoid infinite update loops. Independent of the
   * old symmetry-`pair` position constraint: `pairFlaps` defaults a new
   * symmetry pair to also being equal-paired, but the two are otherwise
   * unrelated (a river-river equal pair has no symmetry constraint at all). */
  syncEqualLength: (id) => {
    const state = get()
    const partner = state.constraints.equalPairs[id]
    if (!partner) return
    const a = state.tree.nodes[id]?.length
    const b = state.tree.nodes[partner]?.length
    if (a == null || b == null || Math.abs(a - b) < 1e-9) return
    const avg = (a + b) / 2
    let tree = setEdgeLengthAction(state.tree, id, avg)
    tree = setEdgeLengthAction(tree, partner, avg)
    set({ tree })
  },

  selectEdge: (id) => set({ selectedEdgeId: id, pinTargetMode: null }),

  setSymmetryMode: (mode) => {
    const prevMode = get().constraints.symmetryMode
    get().pushUndoSnapshot()
    let constraints = withSymmetryMode(get().constraints, mode)
    // Some existing symmetry+boundary combos (book+left/right; a pin_corner
    // that no longer lies on the new symmetry line) become infeasible under
    // the new mode — clear just the boundary half of each, gracefully,
    // rather than leaving the constraints state in a contradictory shape.
    const clearedLeafIds: string[] = []
    for (const [leafId, c] of Object.entries(constraints.perLeaf)) {
      if (!resolveLeafConstraint(mode, c).feasible) {
        constraints = withClearedBoundary(constraints, leafId)
        clearedLeafIds.push(leafId)
      }
    }
    // Nice default (not a hard lock, unlike hexagon's unconditional
    // diagonal rotation) — square/dodecagon read best rotated under diagonal
    // symmetry, so suggest it the moment this combination newly appears.
    const hyperparams = get().hyperparams
    const enteringDiagonal = mode === 'diagonal' && prevMode !== 'diagonal'
    const suggestSquareRotation = enteringDiagonal && hyperparams.shape === 'square'
    const suggestDodecagonRotation = enteringDiagonal && hyperparams.shape === 'dodecagon'
    set({
      constraints,
      hyperparams:
        suggestSquareRotation || suggestDodecagonRotation
          ? {
              ...hyperparams,
              ...(suggestSquareRotation ? { squareExtraRotation: true } : null),
              ...(suggestDodecagonRotation ? { dodecagonExtraRotation: true } : null),
            }
          : hyperparams,
      pairingSourceId: null,
      constraintError:
        clearedLeafIds.length > 0
          ? `Cleared an incompatible edge/corner pin on ${clearedLeafIds.length} flap${clearedLeafIds.length === 1 ? '' : 's'} after the symmetry mode changed.`
          : null,
    })
    for (const leafId of clearedLeafIds) get().snapFlap(leafId)
  },

  armPairing: (leafId) => set({ pairingSourceId: leafId }),
  cancelPairing: () => set({ pairingSourceId: null }),

  armPinTarget: (mode) => set({ pinTargetMode: mode, constraintError: null }),
  cancelPinTarget: () => set({ pinTargetMode: null }),

  pairFlaps: (aId, bId) => {
    if (aId === bId) return
    const state = get()
    if (state.constraints.symmetryMode === 'none') return
    const aBoundary = (state.constraints.perLeaf[aId] ?? NO_LEAF_CONSTRAINT).boundary
    const bBoundary = (state.constraints.perLeaf[bId] ?? NO_LEAF_CONSTRAINT).boundary
    // A pair's boundary pin is one logical constraint mirrored onto both
    // sides (see withPair) — if both already carry independent pins from
    // before pairing, they must already agree, or pairing is rejected.
    if (
      aBoundary.kind !== 'none' &&
      bBoundary.kind !== 'none' &&
      !boundaryEquals(bBoundary, mirrorBoundary(state.constraints.symmetryMode, aBoundary))
    ) {
      set({
        constraintError: 'Pairing two flaps that already have different edge/corner pins is not supported — clear one first.',
        pairingSourceId: null,
      })
      return
    }
    // Position-pairing defaults to also being equal-sized (per the user's
    // expectation for mirror-symmetric flaps) — still independently
    // clearable afterward via clearEqualConstraint, since the two slots are
    // otherwise unrelated.
    const nextConstraints = withEqual(withPair(state.constraints, aId, bId), aId, bId)
    if (findAnyCollision(collectResolvedPoints(state.tree, nextConstraints))) {
      set({ constraintError: 'That pairing would place two flaps at the same position.', pairingSourceId: null })
      return
    }
    get().pushUndoSnapshot()
    set({ constraints: nextConstraints, pairingSourceId: null, constraintError: null })
    get().syncEqualLength(aId)
    // Whichever partner (if either) carries the boundary pin is the
    // authoritative side for the initial snap — the other mirrors it.
    get().snapFlap(bBoundary.kind !== 'none' ? bId : aId)
  },

  armEqual: (id) => set({ equalSourceId: id, constraintError: null }),
  cancelEqual: () => set({ equalSourceId: null }),

  /** Marks two nodes as equal-size — either two flaps or two rivers, never
   * a mix (rejected with a constraintError, matching how pairFlaps rejects
   * an incompatible boundary combo). */
  setEqualPair: (aId, bId) => {
    if (aId === bId) return
    const state = get()
    const a = state.tree.nodes[aId]
    const b = state.tree.nodes[bId]
    if (!a || !b) return
    if ((a.children.length === 0) !== (b.children.length === 0)) {
      set({
        constraintError: 'A flap can only be set equal to another flap, and a river only to another river.',
        equalSourceId: null,
      })
      return
    }
    get().pushUndoSnapshot()
    set({ constraints: withEqual(state.constraints, aId, bId), equalSourceId: null, constraintError: null })
    get().syncEqualLength(aId)
  },

  clearEqualConstraint: (id) => {
    get().pushUndoSnapshot()
    set({ constraints: withClearedEqual(get().constraints, id) })
  },

  pinToSymmetry: (leafId) => {
    const state = get()
    if (state.constraints.symmetryMode === 'none') return
    const current = state.constraints.perLeaf[leafId] ?? NO_LEAF_CONSTRAINT
    const candidate: LeafConstraint = { ...current, symmetry: { kind: 'pin_symmetry' } }
    const res = resolveLeafConstraint(state.constraints.symmetryMode, candidate)
    if (!res.feasible) {
      set({ constraintError: "This flap's edge/corner pin can't be combined with symmetry in this mode." })
      return
    }
    const nextConstraints = withPinSymmetry(state.constraints, leafId)
    if (res.point && findPointCollision(collectResolvedPoints(state.tree, nextConstraints), res.point, leafId)) {
      set({ constraintError: 'That position is already occupied by another flap.' })
      return
    }
    get().pushUndoSnapshot()
    set({ constraints: nextConstraints, constraintError: null })
    get().snapFlap(leafId)
  },

  pinToEdge: (leafId, edge) => {
    const state = get()
    const current = state.constraints.perLeaf[leafId] ?? NO_LEAF_CONSTRAINT
    const candidate: LeafConstraint = { ...current, boundary: { kind: 'pin_edge', edge } }
    const res = resolveLeafConstraint(state.constraints.symmetryMode, candidate)
    if (!res.feasible) {
      set({ constraintError: "That edge can't be combined with this flap's symmetry pin.", pinTargetMode: null })
      return
    }
    const nextConstraints = withPinEdge(state.constraints, leafId, edge)
    // A full collision sweep (not just this leaf's own point) also catches a
    // paired leaf's mirrored pin landing on top of a third flap — or, under
    // diagonal symmetry, on top of its own partner.
    if (findAnyCollision(collectResolvedPoints(state.tree, nextConstraints))) {
      set({ constraintError: 'That position is already occupied by another flap.', pinTargetMode: null })
      return
    }
    get().pushUndoSnapshot()
    set({ constraints: nextConstraints, pinTargetMode: null, constraintError: null })
    get().snapFlap(leafId)
    if (current.symmetry.kind === 'pair') get().snapFlap(current.symmetry.pairedWith)
  },

  pinToCorner: (leafId, corner) => {
    const state = get()
    const current = state.constraints.perLeaf[leafId] ?? NO_LEAF_CONSTRAINT
    const candidate: LeafConstraint = { ...current, boundary: { kind: 'pin_corner', corner } }
    const res = resolveLeafConstraint(state.constraints.symmetryMode, candidate)
    if (!res.feasible) {
      set({ constraintError: "That corner can't be combined with this flap's symmetry pin.", pinTargetMode: null })
      return
    }
    const nextConstraints = withPinCorner(state.constraints, leafId, corner)
    if (findAnyCollision(collectResolvedPoints(state.tree, nextConstraints))) {
      set({ constraintError: 'That corner is already occupied by another flap.', pinTargetMode: null })
      return
    }
    get().pushUndoSnapshot()
    set({ constraints: nextConstraints, pinTargetMode: null, constraintError: null })
    get().snapFlap(leafId)
    if (current.symmetry.kind === 'pair') get().snapFlap(current.symmetry.pairedWith)
  },

  clearSymmetryConstraint: (leafId) => {
    get().pushUndoSnapshot()
    set({ constraints: withClearedSymmetry(get().constraints, leafId) })
    get().snapFlap(leafId)
  },

  clearBoundaryConstraint: (leafId) => {
    const current = get().constraints.perLeaf[leafId] ?? NO_LEAF_CONSTRAINT
    get().pushUndoSnapshot()
    set({ constraints: withClearedBoundary(get().constraints, leafId) })
    get().snapFlap(leafId)
    if (current.symmetry.kind === 'pair') get().snapFlap(current.symmetry.pairedWith)
  },

  toggleLock: (leafId) => {
    const state = get()
    const current = state.constraints.perLeaf[leafId] ?? NO_LEAF_CONSTRAINT
    if (current.locked.kind === 'locked') {
      get().pushUndoSnapshot()
      set({ constraints: withClearedLock(state.constraints, leafId) })
      return
    }
    // Only offered when the leaf isn't already fully fixed by symmetry+
    // boundary alone (locking it would freeze nothing new), and — for a
    // pair — only on the lexicographic leader, since the follower's
    // position is always fully derived via reflection regardless.
    if (isFullyFixedBySymmetryBoundary(state.constraints.symmetryMode, current)) return
    if (current.symmetry.kind === 'pair' && leafId > current.symmetry.pairedWith) return
    const pos = state.packing?.positions[leafId]
    if (!pos) return
    get().pushUndoSnapshot()
    set({ constraints: withLocked(state.constraints, leafId, pos) })
  },

  /** Numeric x/y edits on an already-locked leaf must update the frozen
   * point itself (not just `packing.positions`) — otherwise `moveFlap`'s
   * usual constraint projection would just snap straight back to the old
   * locked point, ignoring the typed value entirely. */
  setLockedPosition: (leafId, x, y) => {
    const state = get()
    const current = state.constraints.perLeaf[leafId]
    if (!current || current.locked.kind !== 'locked') return
    const point = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
    set({ constraints: withLocked(state.constraints, leafId, point) })
    get().moveFlap(leafId, point.x, point.y)
  },

  clearConstraintError: () => set({ constraintError: null }),

  moveFlap: (id, x, y) => {
    const packing = get().packing
    if (!packing) return
    const positions = moveFlapPositions(packing.positions, get().constraints, id, x, y)
    set({ packing: { ...packing, positions } })
  },

  snapFlap: (id) => {
    const pos = get().packing?.positions[id]
    if (!pos) return
    get().moveFlap(id, pos.x, pos.y)
  },

  setPackingScale: (scale) => {
    const packing = get().packing
    if (!packing) return
    set({ packing: { ...packing, scale } })
  },

  setHyperparams: (patch) => {
    const state = get()
    const next = { ...state.hyperparams, ...patch }
    // Same "nice default, not a lock" rotation suggestion as setSymmetryMode,
    // mirrored here for the other direction of the same transition
    // (switching TO square/dodecagon while diagonal is already active).
    if (
      patch.shape === 'square' &&
      state.hyperparams.shape !== 'square' &&
      state.constraints.symmetryMode === 'diagonal' &&
      patch.squareExtraRotation === undefined
    ) {
      next.squareExtraRotation = true
    }
    if (
      patch.shape === 'dodecagon' &&
      state.hyperparams.shape !== 'dodecagon' &&
      state.constraints.symmetryMode === 'diagonal' &&
      patch.dodecagonExtraRotation === undefined
    ) {
      next.dodecagonExtraRotation = true
    }
    set({ hyperparams: next })
  },

  setClipToSquare: (value) => set({ clipToSquare: value }),
  clearUiError: () => set({ uiError: null }),

  runSolve: async () => {
    const state = get()
    const treeIn = toTreeIn(state.tree)
    if (!treeIn) return
    set({ solving: true, solveError: null })
    try {
      const leaves = getLeaves(state.tree)
      const packing = state.packing
      const canUseCurrent = packing != null && leaves.every((id) => packing.positions[id] != null)
      const options = canUseCurrent
        ? {
            initFrom: 'current' as const,
            currentPositions: Object.entries(packing!.positions).map(([nodeId, p]) => ({
              nodeId,
              x: p.x,
              y: p.y,
            })),
            currentScale: packing!.scale,
            // Always run the perturbation-sweep/basin-hopping restart search
            // anchored on the current layout (naive preview or a prior
            // solve) rather than a single deterministic refine — restart 0
            // is always the exact unperturbed seed, so this can never do
            // worse than the old single-shot behavior, only better (see
            // solve_service.py's basin-hopping-style restart loop).
            seedMultiRestart: true,
          }
        : { initFrom: 'random' as const }
      const response = await fetchSolve(treeIn, state.constraints, state.hyperparams, options)
      if (response.status !== 'ok') {
        set({ solveError: response.message ?? 'Solve failed', solving: false })
        return
      }
      const positions: Record<string, { x: number; y: number }> = {}
      for (const p of response.leafPositions) positions[p.nodeId] = { x: p.x, y: p.y }
      for (const p of response.internalPositions) positions[p.nodeId] = { x: p.x, y: p.y }
      get().pushUndoSnapshot()
      set({
        packing: { scale: response.scale, positions, diagnostics: { kind: 'solved', ...response.diagnostics } },
        lastSolvedScale: response.scale,
        solving: false,
      })
    } catch (err) {
      const isNetworkError = err instanceof TypeError
      const message = isNetworkError
        ? `Could not reach the backend at ${API_BASE} — is it running?`
        : err instanceof Error
          ? err.message
          : String(err)
      set({ solveError: message, solving: false })
    }
  },

  snapActivePaths: async () => {
    const state = get()
    const treeIn = toTreeIn(state.tree)
    const packing = state.packing
    if (!treeIn || !packing) return
    if (state.hyperparams.shape === 'circle' || state.hyperparams.shape === 'square') return
    set({ solving: true, solveError: null })
    try {
      const positions = Object.entries(packing.positions).map(([nodeId, p]) => ({ nodeId, x: p.x, y: p.y }))
      const response = await fetchSnapPaths(treeIn, state.constraints, state.hyperparams, positions, packing.scale)
      if (response.status !== 'ok') {
        set({ solveError: response.message ?? 'Snap failed', solving: false })
        return
      }
      if (response.snappedCount === 0) {
        set({ uiError: 'No active paths to snap.', solving: false })
        return
      }
      get().pushUndoSnapshot()
      let tree = state.tree
      for (const { nodeId, length } of response.lengths) {
        tree = setEdgeLengthAction(tree, nodeId, length)
      }
      const nextPositions = { ...packing.positions }
      for (const { nodeId, x, y } of response.leafPositions) {
        nextPositions[nodeId] = { x, y }
      }
      set({
        tree,
        packing: { ...packing, positions: nextPositions },
        solving: false,
      })
    } catch (err) {
      const isNetworkError = err instanceof TypeError
      const message = isNetworkError
        ? `Could not reach the backend at ${API_BASE} — is it running?`
        : err instanceof Error
          ? err.message
          : String(err)
      set({ solveError: message, solving: false })
    }
  },

  snapPathNetwork: async () => {
    const state = get()
    const treeIn = toTreeIn(state.tree)
    const packing = state.packing
    if (!treeIn || !packing) return
    if (state.hyperparams.shape === 'circle' || state.hyperparams.shape === 'square') return
    set({ solving: true, solveError: null })
    try {
      const positions = Object.entries(packing.positions).map(([nodeId, p]) => ({ nodeId, x: p.x, y: p.y }))
      const response = await fetchPathNetworkSnap(treeIn, state.constraints, state.hyperparams, positions, packing.scale)
      if (response.status !== 'ok') {
        set({ solveError: response.message ?? 'Path network snap failed', solving: false })
        return
      }
      if (response.leafPositions.length === 0) {
        set({ uiError: response.message ?? 'No candidate paths found.', solving: false, pathNetworkResult: response })
        return
      }
      get().pushUndoSnapshot()
      let tree = state.tree
      for (const { nodeId, length } of response.lengths) {
        tree = setEdgeLengthAction(tree, nodeId, length)
      }
      const nextPositions = { ...packing.positions }
      for (const { nodeId, x, y } of response.leafPositions) {
        nextPositions[nodeId] = { x, y }
      }
      set({
        tree,
        packing: { ...packing, positions: nextPositions },
        pathNetworkResult: response,
        solving: false,
        uiError: response.message ?? null,
      })
    } catch (err) {
      const isNetworkError = err instanceof TypeError
      const message = isNetworkError
        ? `Could not reach the backend at ${API_BASE} — is it running?`
        : err instanceof Error
          ? err.message
          : String(err)
      set({ solveError: message, solving: false })
    }
  },

  exportSession: () => {
    const state = get()
    const session: SavedSession = {
      version: 5,
      tree: state.tree,
      constraints: state.constraints,
      hyperparams: state.hyperparams,
      packing: state.packing,
      clipToSquare: state.clipToSquare,
    }
    downloadJson('treemaker-session.json', session)
  },

  importSession: (data) => {
    const session = parseSavedSession(data)
    if (!session) {
      throw new Error('Unrecognized session file')
    }
    // Defensive: a hand-edited (or pre-fix) session file could have a root
    // that's topologically a leaf — canonicalize before anything downstream
    // (backfill, rendering) reads rootId.
    const tree = canonicalizeRoot(session.tree)
    // Defensive: parseSavedSession's migration chain already backfills/prunes
    // positions, but a hand-edited (already-v4) file could still be missing
    // some — re-run it here too so the packing-position invariant holds
    // regardless of where the session file came from.
    const packing = session.packing
      ? { ...session.packing, positions: backfillMissingPositions(tree, session.packing.positions) }
      : null
    get().pushUndoSnapshot()
    set({
      tree,
      constraints: session.constraints,
      hyperparams: session.hyperparams,
      packing,
      clipToSquare: session.clipToSquare ?? true,
      lastSolvedScale: packing?.diagnostics.kind === 'solved' ? packing.scale : null,
      activeParentId: null,
      selectedEdgeId: null,
      pairingSourceId: null,
      pinTargetMode: null,
      constraintError: null,
      solveError: null,
    })
  },
}))
