import { create } from 'zustand'
import { API_BASE, fetchSolve } from '../api/client'
import type { ConstraintsState, CornerId, EdgeSide, LeafConstraint, SymmetryMode } from '../types/constraints'
import { DEFAULT_CONSTRAINTS, NO_LEAF_CONSTRAINT } from '../types/constraints'
import type { HyperparamsState } from '../types/hyperparams'
import { DEFAULT_HYPERPARAMS } from '../types/hyperparams'
import type { PackingState } from '../types/solve'
import { hasSolvedOnce } from '../types/solve'
import { toTreeIn } from '../types/tree'
import type { TreeState } from '../types/tree'
import { getLeaves } from '../geometry/treeGeometry'
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
  pruneLeafConstraint,
  withClearedBoundary,
  withClearedLock,
  withClearedSymmetry,
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
  syncPairedLength: (id: string) => void

  selectEdge: (id: string | null) => void
  setSymmetryMode: (mode: SymmetryMode) => void
  armPairing: (leafId: string) => void
  cancelPairing: () => void
  pairFlaps: (aId: string, bId: string) => void
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

  exportSession: () => void
  importSession: (data: unknown) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  tree: { rootId: null, nodes: {} },
  activeParentId: null,
  constraints: DEFAULT_CONSTRAINTS,
  selectedEdgeId: null,
  pairingSourceId: null,
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

  clearSelection: () => set({ selectedEdgeId: null, activeParentId: null, pinTargetMode: null }),

  createRootAt: (x, y) => {
    get().pushUndoSnapshot()
    const tree = createRootNode(x, y)
    set({ tree, activeParentId: tree.rootId, selectedEdgeId: null })
  },

  addChildAt: (parentId, x, y) => {
    get().pushUndoSnapshot()
    const { tree } = addChildNode(get().tree, parentId, x, y)
    // The parent just gained a child, so if it was a leaf carrying a
    // constraint, that constraint no longer makes sense — prune it rather
    // than leave a dangling reference the backend would reject at solve time.
    const { constraints, warning } = pruneLeafConstraint(get().constraints, parentId)
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
    const { constraints } = pruneLeafConstraint(state.constraints, result.deletedId)
    // Prune the deleted id from packing.positions in the same set() call as
    // the tree mutation — tree and packing update atomically, so
    // isPackingStale never observes an intermediate mismatched frame, and
    // deleting never opens a warning/grey-out window (see decision #5).
    let packing = state.packing
    if (packing != null) {
      if (result.tree.rootId == null) {
        packing = null
      } else {
        const { [result.deletedId]: _dropped, ...positions } = packing.positions
        packing = {
          ...packing,
          positions,
          scale: packing.diagnostics.kind === 'naive' ? naiveScale(result.tree) : packing.scale,
        }
      }
    }
    set({
      tree: result.tree,
      constraints,
      packing,
      activeParentId: null,
      selectedEdgeId: null,
      uiError: null,
    })
  },

  moveNode: (id, x, y) => {
    set({ tree: dragNodeTo(get().tree, id, x, y) })
    get().syncPairedLength(id)
  },

  setEdgeLength: (id, length) => {
    set({ tree: setEdgeLengthAction(get().tree, id, length) })
    get().syncPairedLength(id)
  },

  syncPairedLength: (id) => {
    const state = get()
    const c = state.constraints.perLeaf[id]
    if (c?.symmetry.kind !== 'pair') return
    const partner = c.symmetry.pairedWith
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
    // diagonal rotation) — square reads best rotated 45° under diagonal
    // symmetry, so suggest it the moment this combination newly appears.
    const hyperparams = get().hyperparams
    const suggestSquareRotation = mode === 'diagonal' && prevMode !== 'diagonal' && hyperparams.shape === 'square'
    set({
      constraints,
      hyperparams: suggestSquareRotation ? { ...hyperparams, squareExtraRotation: true } : hyperparams,
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
    const nextConstraints = withPair(state.constraints, aId, bId)
    if (findAnyCollision(collectResolvedPoints(state.tree, nextConstraints))) {
      set({ constraintError: 'That pairing would place two flaps at the same position.', pairingSourceId: null })
      return
    }
    get().pushUndoSnapshot()
    set({ constraints: nextConstraints, pairingSourceId: null, constraintError: null })
    get().syncPairedLength(aId)
    // Whichever partner (if either) carries the boundary pin is the
    // authoritative side for the initial snap — the other mirrors it.
    get().snapFlap(bBoundary.kind !== 'none' ? bId : aId)
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
    // Same "nice default, not a lock" square-rotation suggestion as
    // setSymmetryMode, mirrored here for the other direction of the same
    // transition (switching TO square while diagonal is already active).
    if (
      patch.shape === 'square' &&
      state.hyperparams.shape !== 'square' &&
      state.constraints.symmetryMode === 'diagonal' &&
      patch.squareExtraRotation === undefined
    ) {
      next.squareExtraRotation = true
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
            // True only for the very first real solve — a multi-restart
            // search anchored on the naive/manually-adjusted preview layout
            // instead of a single deterministic refine. Every later solve
            // (packing already has a real `solved` diagnostics) keeps the
            // exact single-shot behavior so it iterates precisely from the
            // previous solve + the user's own edits.
            seedMultiRestart: !hasSolvedOnce(packing),
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

  exportSession: () => {
    const state = get()
    const session: SavedSession = {
      version: 4,
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
    // Defensive: parseSavedSession's migration chain already backfills/prunes
    // positions, but a hand-edited (already-v4) file could still be missing
    // some — re-run it here too so the packing-position invariant holds
    // regardless of where the session file came from.
    const packing = session.packing
      ? { ...session.packing, positions: backfillMissingPositions(session.tree, session.packing.positions) }
      : null
    get().pushUndoSnapshot()
    set({
      tree: session.tree,
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
