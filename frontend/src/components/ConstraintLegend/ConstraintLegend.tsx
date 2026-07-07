import { COLOR_CORNER, COLOR_EDGE, COLOR_OVERLAP, COLOR_SYMMETRY, COLOR_UNCONSTRAINED } from '../../constants/constraintColors'
import './ConstraintLegend.css'

const ITEMS = [
  { color: COLOR_UNCONSTRAINED, label: 'Unconstrained' },
  { color: COLOR_SYMMETRY, label: 'Pinned to symmetry' },
  { color: '#7c4dff', label: 'Paired (shared hue per pair)' },
  { color: COLOR_EDGE, label: 'Pinned to edge' },
  { color: COLOR_CORNER, label: 'Pinned to corner' },
  { color: COLOR_OVERLAP, label: 'Overlap / too close' },
]

export function ConstraintLegend() {
  return (
    <div className="constraint-legend">
      {ITEMS.map((item) => (
        <div key={item.label} className="constraint-legend-item">
          <span className="constraint-legend-swatch" style={{ background: item.color }} />
          {item.label}
        </div>
      ))}
    </div>
  )
}
