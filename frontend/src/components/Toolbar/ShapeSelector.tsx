import { useAppStore } from '../../state/store'
import type { ShapeKind } from '../../geometry/shapes'
import { IconButton } from '../icons/IconButton'
import circleIcon from '../../assets/shape_circle.svg'
// import squareIcon from '../../assets/shape_square.svg'
import hexagonIcon from '../../assets/shape_hexagon.svg'
import octagonIcon from '../../assets/shape_octagon.svg'
import dodecagonIcon from '../../assets/shape_dodecagon.svg'
import './ShapeSelector.css'

const OPTIONS: { value: ShapeKind; label: string; icon: string }[] = [
  { value: 'circle', label: 'Circle', icon: circleIcon },
  // { value: 'square', label: 'Square', icon: squareIcon },
  { value: 'dodecagon', label: 'Dodecagon', icon: dodecagonIcon },
  { value: 'octagon', label: 'Octagon', icon: octagonIcon },
  { value: 'hexagon', label: 'Hexagon', icon: hexagonIcon },
]

/** A segmented-radio-style control: one connected track with a sliding
 * highlight thumb behind whichever option is active, rather than
 * independently bordered/backgrounded buttons. Selecting a shape also
 * switches the whole app's color theme (see `hooks/useShapeTheme.ts`). */
export function ShapeSelector() {
  const shape = useAppStore((s) => s.hyperparams.shape)
  const setHyperparams = useAppStore((s) => s.setHyperparams)
  const activeIndex = OPTIONS.findIndex((o) => o.value === shape)

  return (
    <div className="shape-selector">
      <div
        className="shape-selector-thumb"
        style={{
          transform: `translateX(${Math.max(0, activeIndex) * 100}%)`,
          opacity: activeIndex < 0 ? 0 : 1,
        }}
      />
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
