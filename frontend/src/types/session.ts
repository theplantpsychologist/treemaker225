import type { ConstraintsState, CornerId, EdgeSide, LeafConstraint, SymmetryMode } from './constraints'
import type { HyperparamsState } from './hyperparams'
import type { PackingState } from './solve'
import type { TreeState } from './tree'

export interface SavedSession {
  version: 3
  tree: TreeState
  constraints: ConstraintsState
  hyperparams: HyperparamsState
  packing: PackingState | null
  /** Frontend-only display setting (never sent to the backend); optional so
   * session files exported before this field existed still import cleanly. */
  clipToSquare?: boolean
}

/** The two-slot (symmetry/boundary only, no `locked`) constraint shape used
 * by session files exported before the locked-position slot existed — kept
 * only for migration. */
interface LeafConstraintV2 {
  symmetry: LeafConstraint['symmetry']
  boundary: LeafConstraint['boundary']
}

interface SavedSessionV2 {
  version: 2
  tree: TreeState
  constraints: { symmetryMode: SymmetryMode; perLeaf: Record<string, LeafConstraintV2> }
  hyperparams: HyperparamsState
  packing: PackingState | null
  clipToSquare?: boolean
}

/** The single-slot constraint shape used by session files exported before
 * the symmetry/boundary split (Phase 3) — kept only for migration. */
type LegacyFlapConstraint =
  | { kind: 'none' }
  | { kind: 'pin_symmetry' }
  | { kind: 'pair'; pairedWith: string }
  | { kind: 'pin_edge'; edge: EdgeSide }
  | { kind: 'pin_corner'; corner: CornerId }

interface SavedSessionV1 {
  version: 1
  tree: TreeState
  constraints: { symmetryMode: SymmetryMode; perLeaf: Record<string, LegacyFlapConstraint> }
  hyperparams: HyperparamsState
  packing: PackingState | null
  clipToSquare?: boolean
}

function migrateLeafConstraint(old: LegacyFlapConstraint): LeafConstraintV2 {
  switch (old.kind) {
    case 'pin_symmetry':
      return { symmetry: { kind: 'pin_symmetry' }, boundary: { kind: 'none' } }
    case 'pair':
      return { symmetry: { kind: 'pair', pairedWith: old.pairedWith }, boundary: { kind: 'none' } }
    case 'pin_edge':
      return { symmetry: { kind: 'none' }, boundary: { kind: 'pin_edge', edge: old.edge } }
    case 'pin_corner':
      return { symmetry: { kind: 'none' }, boundary: { kind: 'pin_corner', corner: old.corner } }
    default:
      return { symmetry: { kind: 'none' }, boundary: { kind: 'none' } }
  }
}

function migrateSessionV1toV2(v1: SavedSessionV1): SavedSessionV2 {
  const perLeaf: Record<string, LeafConstraintV2> = {}
  for (const [id, c] of Object.entries(v1.constraints.perLeaf)) {
    perLeaf[id] = migrateLeafConstraint(c)
  }
  return {
    version: 2,
    tree: v1.tree,
    constraints: { symmetryMode: v1.constraints.symmetryMode, perLeaf },
    hyperparams: v1.hyperparams,
    packing: v1.packing,
    clipToSquare: v1.clipToSquare,
  }
}

function migrateSessionV2toV3(v2: SavedSessionV2): SavedSession {
  const perLeaf: Record<string, LeafConstraint> = {}
  for (const [id, c] of Object.entries(v2.constraints.perLeaf)) {
    perLeaf[id] = { ...c, locked: { kind: 'none' } }
  }
  return {
    version: 3,
    tree: v2.tree,
    constraints: { symmetryMode: v2.constraints.symmetryMode, perLeaf },
    hyperparams: v2.hyperparams,
    packing: v2.packing,
    clipToSquare: v2.clipToSquare,
  }
}

function looksLikeSession(d: Record<string, unknown>): boolean {
  return typeof d.tree === 'object' && typeof d.constraints === 'object' && typeof d.hyperparams === 'object'
}

/** Parses (and migrates, if necessary) an imported session file. Returns
 * null for anything unrecognized — callers surface that as an import error. */
export function parseSavedSession(data: unknown): SavedSession | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (!looksLikeSession(d)) return null
  if (d.version === 1) return migrateSessionV2toV3(migrateSessionV1toV2(d as unknown as SavedSessionV1))
  if (d.version === 2) return migrateSessionV2toV3(d as unknown as SavedSessionV2)
  if (d.version === 3) return d as unknown as SavedSession
  return null
}
