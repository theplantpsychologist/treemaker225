import { useAppStore } from '../../state/store'
import type { SymmetryMode } from '../../types/constraints'
import { IconButton } from '../icons/IconButton'
import noneIcon from '../../assets/none.svg'
import bookIcon from '../../assets/book_sym.svg'
import diagIcon from '../../assets/diag_sym.svg'

const OPTIONS: { value: SymmetryMode; label: string; icon: string }[] = [
  { value: 'none', label: 'No symmetry', icon: noneIcon },
  { value: 'book', label: 'Book symmetry (mirror across x=0.5)', icon: bookIcon },
  { value: 'diagonal', label: 'Diagonal symmetry (mirror across y=x)', icon: diagIcon },
]

export function SymmetryModeSelector() {
  const symmetryMode = useAppStore((s) => s.constraints.symmetryMode)
  const setSymmetryMode = useAppStore((s) => s.setSymmetryMode)

  return (
    <div className="symmetry-mode-selector">
      {OPTIONS.map((o) => (
        <IconButton
          key={o.value}
          icon={o.icon}
          label={o.label}
          active={symmetryMode === o.value}
          onClick={() => setSymmetryMode(o.value)}
        />
      ))}
    </div>
  )
}
