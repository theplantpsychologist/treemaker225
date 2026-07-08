import { useAppStore } from '../../state/store'
import type { ShapeKind } from '../../geometry/shapes'
import { IconButton } from '../icons/IconButton'
import circleIcon from '../../assets/shape_circle.svg'
import squareIcon from '../../assets/shape_square.svg'
import hexagonIcon from '../../assets/shape_hexagon.svg'
import octagonIcon from '../../assets/shape_octagon.svg'
import dodecagonIcon from '../../assets/shape_dodecagon.svg'

const OPTIONS: { value: ShapeKind; label: string; icon: string }[] = [
  { value: 'circle', label: 'Circle', icon: circleIcon },
  { value: 'square', label: 'Square', icon: squareIcon },
  { value: 'hexagon', label: 'Hexagon', icon: hexagonIcon },
  { value: 'octagon', label: 'Octagon', icon: octagonIcon },
  { value: 'dodecagon', label: 'Dodecagon', icon: dodecagonIcon },
]

/** Mutually-exclusive icon buttons for the packing shape — mirrors
 * `SymmetryModeSelector`'s pattern. Selecting a shape also switches the
 * whole app's color theme (see `hooks/useShapeTheme.ts`). */
export function ShapeSelector() {
  const shape = useAppStore((s) => s.hyperparams.shape)
  const setHyperparams = useAppStore((s) => s.setHyperparams)

  return (
    <div className="shape-selector">
      {OPTIONS.map((o) => (
        <IconButton
          key={o.value}
          icon={o.icon}
          label={o.label}
          active={shape === o.value}
          onClick={() => setHyperparams({ shape: o.value })}
        />
      ))}
    </div>
  )
}
