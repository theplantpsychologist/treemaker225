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
              <h2>Settings</h2>
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
              {hyperparams.shape === 'dodecagon' && (
                <label
                  className="settings-field settings-checkbox"
                  title="Rotate the dodecagon 15 degrees — defaults on when diagonal symmetry is active, but can be toggled either way"
                >
                  <input
                    type="checkbox"
                    checked={hyperparams.dodecagonExtraRotation}
                    onChange={(e) => setHyperparams({ dodecagonExtraRotation: e.target.checked })}
                  />
                  rotate dodecagon 15°
                </label>
              )}
              <hr />
              <h2>Packing solver</h2>
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
              <label
                className="settings-field"
                title="Re-optimize only: largest random perturbation applied to each restart's starting layout, ramping from 0 up to this across the restart budget — helps escape the same local minimum on repeated Optimize clicks"
              >
                max noise amplitude
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={hyperparams.maxNoiseAmplitude}
                  onChange={(e) => setHyperparams({ maxNoiseAmplitude: Number(e.target.value) })}
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

              <h2>Axial topology</h2>
              <label
                className="settings-field"
                title="How far a flap pair's actual center distance may drift from the tree-implied tangency distance (as a fraction of it) and still be drawn as an active path"
              >
                Path length tolerance
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={hyperparams.activeSnapLengthTolerance}
                  onChange={(e) => setHyperparams({ activeSnapLengthTolerance: Number(e.target.value) })}
                />
              </label>
              {hyperparams.shape !== 'circle' && (
                <label
                  className="settings-field"
                  title="How far (in degrees) an active path's angle may drift from the nearest shape-face-normal multiple and still render as a solid line instead of a dashed semi-active parallelogram"
                >
                  Path angle tolerance (°)
                  <input
                    type="number"
                    min={0}
                    max={45}
                    step={1}
                    value={hyperparams.activeSnapAngleTolerance}
                    onChange={(e) => setHyperparams({ activeSnapAngleTolerance: Number(e.target.value) })}
                  />
                </label>
              )}
              <h2>Path network solver</h2>
              <label className="settings-field" title="Weight on the flap-displacement penalty -- larger values keep flaps closer to where they started">
                displacement weight (C1)
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={hyperparams.pathNetworkC1}
                  onChange={(e) => setHyperparams({ pathNetworkC1: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Weight on the length-change term -- rewards a length growing relative to the whole tree, penalizes it shrinking">
                length-change weight (C2)
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={hyperparams.pathNetworkC2}
                  onChange={(e) => setHyperparams({ pathNetworkC2: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Small penalty per active intermediate (bend) point, biasing the solve toward fewer/simpler indirect paths">
                bend-point weight (C3)
                <input
                  type="number"
                  min={0}
                  step={0.001}
                  value={hyperparams.pathNetworkC3}
                  onChange={(e) => setHyperparams({ pathNetworkC3: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="How many outer continuation steps to run before giving up on reaching a fully discrete path selection">
                anneal outer iterations
                <input
                  type="number"
                  min={1}
                  value={hyperparams.pathNetworkAnnealOuterIters}
                  onChange={(e) => setHyperparams({ pathNetworkAnnealOuterIters: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Initial weight of the boolean-relaxation penalty, before it starts growing each outer iteration">
                anneal weight start
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={hyperparams.pathNetworkAnnealWeightStart}
                  onChange={(e) => setHyperparams({ pathNetworkAnnealWeightStart: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="How much the boolean-relaxation penalty weight multiplies by each outer iteration">
                anneal weight growth
                <input
                  type="number"
                  min={1}
                  step={0.5}
                  value={hyperparams.pathNetworkAnnealWeightGrowth}
                  onChange={(e) => setHyperparams({ pathNetworkAnnealWeightGrowth: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Every relaxed path/leg selection must land within this of 0 or 1 for the continuation loop to stop early">
                boolean convergence tolerance
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={hyperparams.pathNetworkBoolEps}
                  onChange={(e) => setHyperparams({ pathNetworkBoolEps: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Basin-hopping restarts wrapping the whole path-network solve, mirroring the main Optimize button's restarts">
                path-network restarts
                <input
                  type="number"
                  min={1}
                  value={hyperparams.pathNetworkNRestarts}
                  onChange={(e) => setHyperparams({ pathNetworkNRestarts: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Largest per-restart random perturbation for the path-network solve's basin hopping">
                path-network max noise amplitude
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={hyperparams.pathNetworkMaxNoiseAmplitude}
                  onChange={(e) => setHyperparams({ pathNetworkMaxNoiseAmplitude: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Upper bound on any length variable, as a multiple of its initial value -- prevents a length with no other constraint from growing without limit">
                length growth cap (x initial)
                <input
                  type="number"
                  min={1}
                  step={0.1}
                  value={hyperparams.pathNetworkGrowthCap}
                  onChange={(e) => setHyperparams({ pathNetworkGrowthCap: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Big-M slack for angle-gated constraints at the start of the anneal schedule -- kept tighter than length since an off-angle crease is a worse defect">
                angle rigidity (big-M start)
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={hyperparams.pathNetworkMAngleStart}
                  onChange={(e) => setHyperparams({ pathNetworkMAngleStart: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Big-M slack for length-gated constraints at the start of the anneal schedule">
                length rigidity (big-M start)
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={hyperparams.pathNetworkMLengthStart}
                  onChange={(e) => setHyperparams({ pathNetworkMLengthStart: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="How much both big-M slacks shrink by every outer anneal iteration">
                rigidity decay per iteration
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={hyperparams.pathNetworkMDecay}
                  onChange={(e) => setHyperparams({ pathNetworkMDecay: Number(e.target.value) })}
                />
              </label>
              <label className="settings-field" title="Smallest either big-M slack is allowed to shrink to during the anneal schedule">
                rigidity floor
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={hyperparams.pathNetworkMFloor}
                  onChange={(e) => setHyperparams({ pathNetworkMFloor: Number(e.target.value) })}
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
