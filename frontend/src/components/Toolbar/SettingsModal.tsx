import { useState } from 'react'
import { useAppStore } from '../../state/store'
import { IconButton } from '../icons/IconButton'
import gearIcon from '../../assets/gear.svg'
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
      {open && (
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
            <button className="settings-done" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </>
  )
}
