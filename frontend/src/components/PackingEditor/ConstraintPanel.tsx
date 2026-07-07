import { useAppStore } from '../../state/store'
import type { FlapConstraint } from '../../types/constraints'
import './ConstraintPanel.css'

const NO_CONSTRAINT: FlapConstraint = { kind: 'none' }

export function ConstraintPanel() {
  const selectedFlapId = useAppStore((s) => s.selectedFlapId)
  const symmetryMode = useAppStore((s) => s.constraints.symmetryMode)
  const constraint = useAppStore((s) =>
    s.selectedFlapId ? (s.constraints.perLeaf[s.selectedFlapId] ?? NO_CONSTRAINT) : NO_CONSTRAINT,
  )
  const pairingSourceId = useAppStore((s) => s.pairingSourceId)
  const armPairing = useAppStore((s) => s.armPairing)
  const cancelPairing = useAppStore((s) => s.cancelPairing)
  const pinToSymmetry = useAppStore((s) => s.pinToSymmetry)
  const clearConstraint = useAppStore((s) => s.clearConstraint)
  const selectFlap = useAppStore((s) => s.selectFlap)

  if (pairingSourceId) {
    return (
      <div className="constraint-panel">
        <span>Click another flap to pair with it…</span>
        <button onClick={cancelPairing}>Cancel</button>
      </div>
    )
  }

  if (!selectedFlapId) return null

  return (
    <div className="constraint-panel">
      <span className="constraint-panel-label">flap: {selectedFlapId.slice(0, 6)}</span>
      <button disabled={symmetryMode === 'none'} onClick={() => pinToSymmetry(selectedFlapId)}>
        Pin to symmetry
      </button>
      <button disabled={symmetryMode === 'none'} onClick={() => armPairing(selectedFlapId)}>
        Pair…
      </button>
      <button disabled={constraint.kind === 'none'} onClick={() => clearConstraint(selectedFlapId)}>
        Clear
      </button>
      <button onClick={() => selectFlap(null)}>Done</button>
    </div>
  )
}
