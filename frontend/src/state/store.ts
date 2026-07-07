import { create } from 'zustand'
import { API_BASE, fetchSolve } from '../api/client'
import type { ConstraintsState, CornerId, EdgeSide, SymmetryMode } from '../types/constraints'
import { DEFAULT_CONSTRAINTS } from '../types/constraints'
import type { HyperparamsState } from '../types/hyperparams'
import { DEFAULT_HYPERPARAMS } from '../types/hyperparams'
import type { InitFrom, PackingState } from '../types/solve'
import { toTreeIn } from '../types/tree'
import type { TreeState } from '../types/tree'
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

interface AppState {
  tree: TreeState
  selectedNodeId: string | null
  constraints: ConstraintsState
  selectedFlapId: string | null
  pairingSourceId: string | null
  hyperparams: HyperparamsState
  initFrom: InitFrom
  packing: PackingState | null
  solving: boolean
  solveError: string | null

  selectNode: (id: string | null) => void
  createRootAt: (x: number, y: number) => void
  addChildAt: (parentId: string, x: number, y: number) => void
  moveNode: (id: string, x: number, y: number) => void
  setEdgeLength: (id: string, length: number) => void
  syncPairedLength: (id: string) => void

  selectFlap: (id: string | null) => void
  setSymmetryMode: (mode: SymmetryMode) => void
  armPairing: (leafId: string) => void
  cancelPairing: () => void
  pairFlaps: (aId: string, bId: string) => void
  pinToSymmetry: (leafId: string) => void
  pinToEdge: (leafId: string, edge: EdgeSide) => void
  pinToCorner: (leafId: string, corner: CornerId) => void
  clearConstraint: (leafId: string) => void
  moveFlap: (id: string, x: number, y: number) => void
  snapFlap: (id: string) => void

  setHyperparams: (hyperparams: Partial<HyperparamsState>) => void
  setInitFrom: (initFrom: InitFrom) => void
  runSolve: () => Promise<void>

  exportSession: () => void
  importSession: (data: unknown) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  tree: { rootId: null, nodes: {} },
  selectedNodeId: null,
  constraints: DEFAULT_CONSTRAINTS,
  selectedFlapId: null,
  pairingSourceId: null,
  hyperparams: DEFAULT_HYPERPARAMS,
  initFrom: 'random',
  packing: null,
  solving: false,
  solveError: null,

  selectNode: (id) => set({ selectedNodeId: id }),

  createRootAt: (x, y) => {
    const tree = createRootNode(x, y)
    set({ tree, selectedNodeId: tree.rootId })
  },

  addChildAt: (parentId, x, y) => {
    const { tree, newId } = addChildNode(get().tree, parentId, x, y)
    set({ tree, selectedNodeId: newId })
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

  selectFlap: (id) => set({ selectedFlapId: id }),

  setSymmetryMode: (mode) => {
    set({ constraints: withSymmetryMode(get().constraints, mode), pairingSourceId: null })
  },

  armPairing: (leafId) => set({ pairingSourceId: leafId }),
  cancelPairing: () => set({ pairingSourceId: null }),

  pairFlaps: (aId, bId) => {
    if (aId === bId) return
    const state = get()
    if (state.constraints.symmetryMode === 'none') return
    set({ constraints: withPair(state.constraints, aId, bId), pairingSourceId: null })
    get().syncPairedLength(aId)
    get().snapFlap(aId)
  },

  pinToSymmetry: (leafId) => {
    const state = get()
    if (state.constraints.symmetryMode === 'none') return
    set({ constraints: withPinSymmetry(state.constraints, leafId) })
    get().snapFlap(leafId)
  },

  pinToEdge: (leafId, edge) => {
    set({ constraints: withPinEdge(get().constraints, leafId, edge) })
    get().snapFlap(leafId)
  },

  pinToCorner: (leafId, corner) => {
    set({ constraints: withPinCorner(get().constraints, leafId, corner) })
    get().snapFlap(leafId)
  },

  clearConstraint: (leafId) => {
    set({ constraints: withClearedConstraint(get().constraints, leafId) })
  },

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

  setHyperparams: (patch) => {
    set({ hyperparams: { ...get().hyperparams, ...patch } })
  },

  setInitFrom: (initFrom) => set({ initFrom }),

  runSolve: async () => {
    const state = get()
    const treeIn = toTreeIn(state.tree)
    if (!treeIn) return
    set({ solving: true, solveError: null })
    try {
      const useCurrent = state.initFrom === 'current' && state.packing != null
      const options = useCurrent
        ? {
            initFrom: 'current' as const,
            currentPositions: Object.entries(state.packing!.positions).map(([nodeId, p]) => ({
              nodeId,
              x: p.x,
              y: p.y,
            })),
            currentScale: state.packing!.scale,
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
      set({
        packing: { scale: response.scale, positions, diagnostics: response.diagnostics },
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
    set({
      tree: data.tree,
      constraints: data.constraints,
      hyperparams: data.hyperparams,
      packing: data.packing,
      selectedNodeId: null,
      selectedFlapId: null,
      pairingSourceId: null,
      solveError: null,
    })
  },
}))
