import { useAppStore } from '../../state/store'
import { SHAPE_OPTIONS } from '../../geometry/shapes'
import type { ShapeKind } from '../../geometry/shapes'

export function ShapeSelector() {
  const shape = useAppStore((s) => s.hyperparams.shape)
  const setHyperparams = useAppStore((s) => s.setHyperparams)

  return (
    <label className="hp-field" title="Packing shape used by the solver and shown in the packing view">
      shape
      <select value={shape} onChange={(e) => setHyperparams({ shape: e.target.value as ShapeKind })}>
        {SHAPE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
