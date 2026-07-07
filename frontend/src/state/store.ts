import { create } from 'zustand'
import { API_BASE, fetchSolve } from '../api/client'
import type { ConstraintsState, CornerId, EdgeSide, SymmetryMode } from '../types/constraints'
import { DEFAULT_CONSTRAINTS } from '../types/constraints'
import type { HyperparamsState } from '../types/hyperparams'
import { DEFAULT_HYPERPARAMS } from '../types/hyperparams'
import type { PackingState } from '../types/solve'
import { toTreeIn } from '../types/tree'
import type { TreeState } from '../types/tree'
import { getLeaves } from '../geometry/treeGeometry'
import {
  addChildNode,
  createRootNode,
  dragNodeTo,
  setEdgeLength as setEdgeLengthAction,
} from './actions/treeActions'
import {
  withClearedConstraint,
  withPair,
  withPinCorner,
  withPinEdge,
  withPinSymmetry,
  withSymmetryMode,
} from './actions/constraintActions'
import { moveFlapPositions } from './actions/packingActions'
import type { SavedSession } from '../types/session'
import { isSavedSession } from '../types/session'
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
  packing: PackingState | null
  lastSolvedScale: number | null
  solving: boolean
  solveError: string | null
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
  clearConstraint: (leafId: string) => void
  clearConstraintError: () => void
  moveFlap: (id: string, x: number, y: number) => void
  snapFlap: (id: string) => void
  setPackingScale: (scale: number) => void

  setHyperparams: (hyperparams: Partial<HyperparamsState>) => void
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
  packing: null,
  lastSolvedScale: null,
  solving: false,
  solveError: null,
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
    set({ tree })
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
    if (c?.kind !== 'pair') return
    const partner = c.pairedWith
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
    get().pushUndoSnapshot()
    set({ constraints: withSymmetryMode(get().constraints, mode), pairingSourceId: null })
  },

  armPairing: (leafId) => set({ pairingSourceId: leafId }),
  cancelPairing: () => set({ pairingSourceId: null }),

  armPinTarget: (mode) => set({ pinTargetMode: mode, constraintError: null }),
  cancelPinTarget: () => set({ pinTargetMode: null }),

  pairFlaps: (aId, bId) => {
    if (aId === bId) return
    const state = get()
    if (state.constraints.symmetryMode === 'none') return
    get().pushUndoSnapshot()
    set({ constraints: withPair(state.constraints, aId, bId), pairingSourceId: null })
    get().syncPairedLength(aId)
    get().snapFlap(aId)
  },

  pinToSymmetry: (leafId) => {
    const state = get()
    if (state.constraints.symmetryMode === 'none') return
    get().pushUndoSnapshot()
    set({ constraints: withPinSymmetry(state.constraints, leafId) })
    get().snapFlap(leafId)
  },

  pinToEdge: (leafId, edge) => {
    get().pushUndoSnapshot()
    set({ constraints: withPinEdge(get().constraints, leafId, edge), pinTargetMode: null, constraintError: null })
    get().snapFlap(leafId)
  },

  pinToCorner: (leafId, corner) => {
    const state = get()
    const conflict = Object.entries(state.constraints.perLeaf).find(
      ([id, c]) => id !== leafId && c.kind === 'pin_corner' && c.corner === corner,
    )
    if (conflict) {
      set({ constraintError: 'That corner is already pinned by another flap.', pinTargetMode: null })
      return
    }
    get().pushUndoSnapshot()
    set({ constraints: withPinCorner(state.constraints, leafId, corner), pinTargetMode: null, constraintError: null })
    get().snapFlap(leafId)
  },

  clearConstraint: (leafId) => {
    get().pushUndoSnapshot()
    set({ constraints: withClearedConstraint(get().constraints, leafId) })
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
    set({ hyperparams: { ...get().hyperparams, ...patch } })
  },

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
        packing: { scale: response.scale, positions, diagnostics: response.diagnostics },
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
      version: 1,
      tree: state.tree,
      constraints: state.constraints,
      hyperparams: state.hyperparams,
      packing: state.packing,
    }
    downloadJson('treemaker-session.json', session)
  },

  importSession: (data) => {
    if (!isSavedSession(data)) {
      throw new Error('Unrecognized session file')
    }
    get().pushUndoSnapshot()
    set({
      tree: data.tree,
      constraints: data.constraints,
      hyperparams: data.hyperparams,
      packing: data.packing,
      lastSolvedScale: data.packing?.scale ?? null,
      activeParentId: null,
      selectedEdgeId: null,
      pairingSourceId: null,
      pinTargetMode: null,
      constraintError: null,
      solveError: null,
    })
  },
}))
