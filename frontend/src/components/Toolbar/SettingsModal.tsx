import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../../state/store'
import { IconButton } from '../icons/IconButton'
import gearIcon from '../../assets/gear.svg'
import type { SolverMethod } from '../../types/hyperparams'
import './SettingsModal.css'

export function SettingsModal() {
  const [open, setOpen] = useState(false)
  const hyperparams = useAppStore((s) => s.hyperparams)
  const setHyperparams = useAppStore((s) => s.setHyperparams)
  const clipToSquare = useAppStore((s) => s.clipToSquare)
  const setClipToSquare = useAppStore((s) => s.setClipToSquare)
  const refines = hyperparams.shape !== 'circle'

  return (
    <>
      <IconButton icon={gearIcon} label="Advanced solver settings" onClick={() => setOpen(true)} />
      {open &&
        createPortal(
          <div className="settings-modal-backdrop" onClick={() => setOpen(false)}>
            <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
              <h3>Advanced settings</h3>
              <label className="settings-field" title="Number of random-restart circle-packing solves">
                restarts
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={hyperparams.nRestarts}
                  onChange={(e) => setHyperparams({ nRestarts: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="How many top circle-packing candidates get refined into the chosen shape">
                refine
                <input
                  type="number"
                  min={1}
                  max={hyperparams.nRestarts}
                  value={hyperparams.nRefine}
                  disabled={!refines}
                  onChange={(e) => setHyperparams({ nRefine: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Softmax smoothing factor for the shape's separating-axis constraint">
                alpha
                <input
                  type="number"
                  min={1}
                  step={10}
                  value={hyperparams.alpha}
                  disabled={!refines}
                  onChange={(e) => setHyperparams({ alpha: Number(e.target.value) })}
                />
              </label>
              <label
                className="settings-field settings-checkbox"
                title="Hide any part of a flap/river that spills past the paper square"
              >
                <input
                  type="checkbox"
                  checked={clipToSquare}
                  onChange={(e) => setClipToSquare(e.target.checked)}
                />
                clip to paper square
              </label>
              {hyperparams.shape === 'hexagon' && (
                <label
                  className="settings-field settings-checkbox"
                  title="Rotate all hexagons an extra 90 degrees on top of whatever the symmetry mode already applies"
                >
                  <input
                    type="checkbox"
                    checked={hyperparams.hexagonExtraRotation}
                    onChange={(e) => setHyperparams({ hexagonExtraRotation: e.target.checked })}
                  />
                  rotate hexagons 90°
                </label>
              )}
              {hyperparams.shape === 'square' && (
                <label
                  className="settings-field settings-checkbox"
                  title="Rotate the square 45 degrees into a diamond — defaults on when diagonal symmetry is active, but can be toggled either way"
                >
                  <input
                    type="checkbox"
                    checked={hyperparams.squareExtraRotation}
                    onChange={(e) => setHyperparams({ squareExtraRotation: e.target.checked })}
                  />
                  rotate square 45°
                </label>
              )}
              <label className="settings-field" title="Optimizer used for every restart — SLSQP is the default; trust-constr can be more robust on large/hard trees">
                method
                <select
                  value={hyperparams.solverMethod}
                  onChange={(e) => setHyperparams({ solverMethod: e.target.value as SolverMethod })}
                >
                  <option value="slsqp">SLSQP</option>
                  <option value="cobyla">COBYLA</option>
                  <option value="trust-constr">trust-constr</option>
                </select>
              </label>
              <label className="settings-field" title="Convergence tolerance passed to the optimizer — leave blank for scipy's default">
                tol
                <input
                  type="number"
                  min={0}
                  step="any"
                  placeholder="auto"
                  value={hyperparams.tol ?? ''}
                  onChange={(e) => setHyperparams({ tol: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Maximum optimizer iterations per restart — leave blank for scipy's default">
                max iter
                <input
                  type="number"
                  min={1}
                  placeholder="auto"
                  value={hyperparams.maxIter ?? ''}
                  onChange={(e) => setHyperparams({ maxIter: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </label>
              <button className="settings-done" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
