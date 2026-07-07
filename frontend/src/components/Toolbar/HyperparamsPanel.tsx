import { useAppStore } from '../../state/store'
import type { InitFrom } from '../../types/solve'
import './HyperparamsPanel.css'

export function HyperparamsPanel() {
  const tree = useAppStore((s) => s.tree)
  const hyperparams = useAppStore((s) => s.hyperparams)
  const solving = useAppStore((s) => s.solving)
  const packing = useAppStore((s) => s.packing)
  const initFrom = useAppStore((s) => s.initFrom)
  const setInitFrom = useAppStore((s) => s.setInitFrom)
  const setHyperparams = useAppStore((s) => s.setHyperparams)
  const runSolve = useAppStore((s) => s.runSolve)

  return (
    <div className="pane-toolbar">
      <label className="hp-field" title="Number of random-restart circle-packing solves">
        restarts
        <input
          type="number"
          min={1}
          max={500}
          value={hyperparams.nRestarts}
          onChange={(e) => setHyperparams({ nRestarts: Number(e.target.value) })}
        />
      </label>
      <label className="hp-field" title="How many top circle-packing candidates get refined into octagon mode">
        refine
        <input
          type="number"
          min={1}
          max={hyperparams.nRestarts}
          value={hyperparams.nRefine}
          disabled={!hyperparams.runOctagonRefinement}
          onChange={(e) => setHyperparams({ nRefine: Number(e.target.value) })}
        />
      </label>
      <label className="hp-field" title="Softmax smoothing factor for the octagon separating-axis constraint">
        alpha
        <input
          type="number"
          min={1}
          step={10}
          value={hyperparams.alpha}
          disabled={!hyperparams.runOctagonRefinement}
          onChange={(e) => setHyperparams({ alpha: Number(e.target.value) })}
        />
      </label>
      <label className="hp-field hp-checkbox" title="Refine circle packing into an octagon packing">
        <input
          type="checkbox"
          checked={hyperparams.runOctagonRefinement}
          onChange={(e) => setHyperparams({ runOctagonRefinement: e.target.checked })}
        />
        octagons
      </label>
      <label className="hp-field" title="Seed the solver from random restarts, or from the packing's current positions">
        init
        <select value={initFrom} onChange={(e) => setInitFrom(e.target.value as InitFrom)} disabled={!packing}>
          <option value="random">Random restarts</option>
          <option value="current">Current positions</option>
        </select>
      </label>
      <button onClick={() => void runSolve()} disabled={solving || !tree.rootId}>
        {solving ? 'Solving…' : 'Run Solver'}
      </button>
    </div>
  )
}
