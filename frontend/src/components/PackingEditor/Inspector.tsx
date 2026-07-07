import { useAppStore } from '../../state/store'
import type { FlapConstraint } from '../../types/constraints'
import './Inspector.css'

const NO_CONSTRAINT: FlapConstraint = { kind: 'none' }

export function Inspector() {
  const selectedEdgeId = useAppStore((s) => s.selectedEdgeId)
  const tree = useAppStore((s) => s.tree)
  const packing = useAppStore((s) => s.packing)
  const symmetryMode = useAppStore((s) => s.constraints.symmetryMode)
  const constraint = useAppStore((s) =>
    s.selectedEdgeId ? (s.constraints.perLeaf[s.selectedEdgeId] ?? NO_CONSTRAINT) : NO_CONSTRAINT,
  )
  const pairingSourceId = useAppStore((s) => s.pairingSourceId)
  const armPairing = useAppStore((s) => s.armPairing)
  const cancelPairing = useAppStore((s) => s.cancelPairing)
  const pinTargetMode = useAppStore((s) => s.pinTargetMode)
  const armPinTarget = useAppStore((s) => s.armPinTarget)
  const cancelPinTarget = useAppStore((s) => s.cancelPinTarget)
  const constraintError = useAppStore((s) => s.constraintError)
  const clearConstraintError = useAppStore((s) => s.clearConstraintError)
  const pinToSymmetry = useAppStore((s) => s.pinToSymmetry)
  const clearConstraint = useAppStore((s) => s.clearConstraint)
  const selectEdge = useAppStore((s) => s.selectEdge)

  const errorBanner = constraintError ? (
    <div className="inspector-panel inspector-panel-error" key="error">
      <span>{constraintError}</span>
      <button onClick={clearConstraintError}>Dismiss</button>
    </div>
  ) : null

  let body = null
  if (pairingSourceId) {
    body = (
      <div className="inspector-panel">
        <span>Click another flap to pair with it…</span>
        <button onClick={cancelPairing}>Cancel</button>
      </div>
    )
  } else if (pinTargetMode) {
    body = (
      <div className="inspector-panel">
        <span>Click a {pinTargetMode} of the square to pin to…</span>
        <button onClick={cancelPinTarget}>Cancel</button>
      </div>
    )
  } else if (selectedEdgeId && tree.nodes[selectedEdgeId]) {
    const node = tree.nodes[selectedEdgeId]
    const isLeaf = node.parentId !== null && node.children.length === 0
    const width = packing && node.length != null ? packing.scale * node.length : null
    body = isLeaf ? (
      <div className="inspector-panel">
        <span className="inspector-label">flap: {selectedEdgeId.slice(0, 6)}</span>
        <button disabled={symmetryMode === 'none'} onClick={() => pinToSymmetry(selectedEdgeId)}>
          Pin to symmetry
        </button>
        <button onClick={() => armPinTarget('edge')}>Pin to edge</button>
        <button onClick={() => armPinTarget('corner')}>Pin to corner</button>
        <button disabled={symmetryMode === 'none'} onClick={() => armPairing(selectedEdgeId)}>
          Pair…
        </button>
        <button disabled={constraint.kind === 'none'} onClick={() => clearConstraint(selectedEdgeId)}>
          Clear
        </button>
        <button onClick={() => selectEdge(null)}>Done</button>
      </div>
    ) : (
      <div className="inspector-panel">
        <span className="inspector-label">River</span>
        {width != null && <span className="inspector-width">width: {width.toFixed(4)}</span>}
        <span className="inspector-hint">No constraints for a river.</span>
        <button onClick={() => selectEdge(null)}>Done</button>
      </div>
    )
  }

  if (!errorBanner && !body) return null
  return (
    <div className="inspector-stack">
      {errorBanner}
      {body}
    </div>
  )
}
