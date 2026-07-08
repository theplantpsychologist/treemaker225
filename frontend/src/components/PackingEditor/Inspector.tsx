import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import type { LeafConstraint } from '../../types/constraints'
import { NO_LEAF_CONSTRAINT } from '../../types/constraints'
import { axisFreedom, collectResolvedPoints, isFullyFixedBySymmetryBoundary } from '../../geometry/constraintResolution'
import { IconButton } from '../icons/IconButton'
import pinSymmetryIcon from '../../assets/pin_symmetry.svg'
import pairIcon from '../../assets/pair.svg'
import pinEdgeIcon from '../../assets/pin_edge.svg'
import pinCornerIcon from '../../assets/pin_corner.svg'
import lockIcon from '../../assets/lock.svg'
import clearIcon from '../../assets/clear.svg'
import './Inspector.css'

function symmetryLabel(constraint: LeafConstraint) {
  const s = constraint.symmetry
  if (s.kind === 'pin_symmetry') return 'pinned to symmetry line'
  if (s.kind === 'pair') return `paired with ${s.pairedWith.slice(0, 6)}`
  return 'none'
}

function boundaryLabel(constraint: LeafConstraint) {
  const b = constraint.boundary
  if (b.kind === 'pin_edge') return `pinned to ${b.edge} edge`
  if (b.kind === 'pin_corner') return `pinned to ${b.corner.replace('_', ' ')} corner`
  return 'none'
}

/** A live-updating numeric field that tolerates in-progress text (a trailing
 * "." or "-") without fighting the user's typing, but commits as soon as the
 * text parses to a finite number — and resyncs from external position
 * changes (drag, switching flaps) when not actively equal to what it last
 * committed itself. */
function NumberField({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (v: number) => void }) {
  const [text, setText] = useState(() => value.toFixed(4))
  const lastCommitted = useRef(value)
  useEffect(() => {
    if (Math.abs(lastCommitted.current - value) > 1e-9) {
      setText(value.toFixed(4))
      lastCommitted.current = value
    }
  }, [value])
  return (
    <input
      type="text"
      inputMode="decimal"
      className="inspector-position-input"
      value={text}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value
        setText(v)
        const parsed = Number(v)
        if (v.trim() !== '' && Number.isFinite(parsed)) {
          lastCommitted.current = parsed
          onCommit(parsed)
        }
      }}
    />
  )
}

export function Inspector() {
  const selectedEdgeId = useAppStore((s) => s.selectedEdgeId)
  const tree = useAppStore((s) => s.tree)
  const packing = useAppStore((s) => s.packing)
  const constraints = useAppStore((s) => s.constraints)
  const symmetryMode = constraints.symmetryMode
  const constraint = selectedEdgeId ? (constraints.perLeaf[selectedEdgeId] ?? NO_LEAF_CONSTRAINT) : NO_LEAF_CONSTRAINT
  const resolvedFixedLeafIds = useMemo(
    () => new Set(collectResolvedPoints(tree, constraints).map((e) => e.leafId)),
    [tree, constraints],
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
  const clearSymmetryConstraint = useAppStore((s) => s.clearSymmetryConstraint)
  const clearBoundaryConstraint = useAppStore((s) => s.clearBoundaryConstraint)
  const toggleLock = useAppStore((s) => s.toggleLock)
  const moveFlap = useAppStore((s) => s.moveFlap)
  const setLockedPosition = useAppStore((s) => s.setLockedPosition)
  const selectEdge = useAppStore((s) => s.selectEdge)

  const errorBanner = constraintError ? (
    <div className="inspector-panel inspector-panel-error" key="error">
      <div className="inspector-panel-header">
        <span>{constraintError}</span>
        <IconButton icon={clearIcon} label="Dismiss" onClick={clearConstraintError} />
      </div>
    </div>
  ) : null

  let body = null
  if (pairingSourceId) {
    body = (
      <div className="inspector-panel">
        <span>Click another flap to pair with it…</span>
        <button className="inspector-text-button" onClick={cancelPairing}>
          Cancel
        </button>
      </div>
    )
  } else if (pinTargetMode) {
    body = (
      <div className="inspector-panel">
        <span>Click a {pinTargetMode} of the square to pin to…</span>
        <button className="inspector-text-button" onClick={cancelPinTarget}>
          Cancel
        </button>
      </div>
    )
  } else if (selectedEdgeId && tree.nodes[selectedEdgeId]) {
    const node = tree.nodes[selectedEdgeId]
    const isLeaf = node.parentId !== null && node.children.length === 0
    const width = packing && node.length != null ? packing.scale * node.length : null
    const pos = packing?.positions[selectedEdgeId]
    const isLocked = constraint.locked.kind === 'locked'
    const freedom = isLocked ? { x: 'free' as const, y: 'free' as const } : axisFreedom(symmetryMode, constraint)
    const isPositionBlocked = !isLocked && resolvedFixedLeafIds.has(selectedEdgeId)
    const xFixed = isPositionBlocked || freedom.x === 'fixed'
    const yFixed = isPositionBlocked || freedom.y === 'fixed'
    const linked = !isPositionBlocked && freedom.x === 'linked'
    const commitX = (v: number) => {
      if (!pos) return
      const y = linked ? v : pos.y
      if (isLocked) setLockedPosition(selectedEdgeId, v, y)
      else moveFlap(selectedEdgeId, v, y)
    }
    const commitY = (v: number) => {
      if (!pos) return
      const x = linked ? v : pos.x
      if (isLocked) setLockedPosition(selectedEdgeId, x, v)
      else moveFlap(selectedEdgeId, x, v)
    }
    body = isLeaf ? (
      <div className="inspector-panel">
        <div className="inspector-panel-header">
          <span className="inspector-label">flap: {selectedEdgeId.slice(0, 6)}</span>
          <IconButton icon={clearIcon} label="Deselect" onClick={() => selectEdge(null)} />
        </div>

        <div className="inspector-group">
          <span className="inspector-group-label">position</span>
          <div className="inspector-position-fields">
            <label>
              x
              <NumberField value={pos?.x ?? 0} disabled={!pos || xFixed} onCommit={commitX} />
            </label>
            <label>
              y
              <NumberField value={pos?.y ?? 0} disabled={!pos || yFixed} onCommit={commitY} />
            </label>
          </div>
          {width != null && <span className="inspector-width">radius: {width.toFixed(4)}</span>}
        </div>

        <div className="inspector-group">
          <span className="inspector-group-label">symmetry constraint: {symmetryLabel(constraint)}</span>
          <div className="inspector-group-buttons">
            <IconButton
              icon={pinSymmetryIcon}
              label="Pin to symmetry line"
              active={constraint.symmetry.kind === 'pin_symmetry'}
              disabled={symmetryMode === 'none'}
              onClick={() => pinToSymmetry(selectedEdgeId)}
            />
            <IconButton
              icon={pairIcon}
              label="Pair with another flap"
              active={constraint.symmetry.kind === 'pair'}
              disabled={symmetryMode === 'none'}
              onClick={() => armPairing(selectedEdgeId)}
            />
            <IconButton
              icon={clearIcon}
              label="Clear symmetry constraint"
              disabled={constraint.symmetry.kind === 'none'}
              onClick={() => clearSymmetryConstraint(selectedEdgeId)}
            />
          </div>
        </div>

        <div className="inspector-group">
          <span className="inspector-group-label">boundary constraint: {boundaryLabel(constraint)}</span>
          <div className="inspector-group-buttons">
            <IconButton
              icon={pinEdgeIcon}
              label="Pin to a paper edge"
              active={constraint.boundary.kind === 'pin_edge'}
              onClick={() => armPinTarget('edge')}
            />
            <IconButton
              icon={pinCornerIcon}
              label="Pin to a paper corner"
              active={constraint.boundary.kind === 'pin_corner'}
              onClick={() => armPinTarget('corner')}
            />
            <IconButton
              icon={clearIcon}
              label="Clear edge/corner constraint"
              disabled={constraint.boundary.kind === 'none'}
              onClick={() => clearBoundaryConstraint(selectedEdgeId)}
            />
          </div>
        </div>

        <div className="inspector-group">
          <span className="inspector-group-label">{constraint.locked.kind === 'locked' ? 'locked in place' : 'not locked'}</span>
          <div className="inspector-group-buttons">
            <IconButton
              icon={lockIcon}
              label={constraint.locked.kind === 'locked' ? 'Unlock' : 'Lock in place'}
              active={constraint.locked.kind === 'locked'}
              disabled={
                constraint.locked.kind !== 'locked' &&
                (isFullyFixedBySymmetryBoundary(symmetryMode, constraint) ||
                  (constraint.symmetry.kind === 'pair' && selectedEdgeId > constraint.symmetry.pairedWith))
              }
              onClick={() => toggleLock(selectedEdgeId)}
            />
          </div>
        </div>
      </div>
    ) : (
      <div className="inspector-panel">
        <div className="inspector-panel-header">
          <span className="inspector-label">River</span>
          <IconButton icon={clearIcon} label="Deselect" onClick={() => selectEdge(null)} />
        </div>
        {width != null && <span className="inspector-width">width: {width.toFixed(4)}</span>}
        <span className="inspector-hint">No constraints applicable.</span>
      </div>
    )
  }

  if (!errorBanner && !body) return null
  return (
    <div className="inspector-rail">
      {errorBanner}
      {body}
    </div>
  )
}
