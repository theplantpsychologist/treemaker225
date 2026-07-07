import { useAppStore } from '../../state/store'
import type { SymmetryMode } from '../../types/constraints'

const OPTIONS: { value: SymmetryMode; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'book', label: 'Book' },
  { value: 'diagonal', label: 'Diagonal' },
]

export function SymmetryModeSelector() {
  const symmetryMode = useAppStore((s) => s.constraints.symmetryMode)
  const setSymmetryMode = useAppStore((s) => s.setSymmetryMode)

  return (
    <label className="hp-field" title="Symmetry line used by pin-to-symmetry and pair constraints">
      symmetry
      <select value={symmetryMode} onChange={(e) => setSymmetryMode(e.target.value as SymmetryMode)}>
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
