import { COLOR_OVERLAP } from '../../constants/constraintColors'
import './ConstraintLegend.css'

const ITEMS = [
  { swatchClassName: 'constraint-legend-swatch-flap', label: 'Flap' },
  { swatchClassName: 'constraint-legend-swatch-river', label: 'River' },
  { color: COLOR_OVERLAP, label: 'Overlap / too close' },
]

export function ConstraintLegend() {
  return (
    <div className="constraint-legend">
      {ITEMS.map((item) => (
        <div key={item.label} className="constraint-legend-item">
          <span
            className={'constraint-legend-swatch' + (item.swatchClassName ? ` ${item.swatchClassName}` : '')}
            style={item.color ? { background: item.color } : undefined}
          />
          {item.label}
        </div>
      ))}
    </div>
  )
}
