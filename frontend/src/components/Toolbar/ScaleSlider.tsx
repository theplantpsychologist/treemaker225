import { useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useAppStore } from '../../state/store'
import { isPackingStale } from '../../geometry/topology'
import './ScaleSlider.css'

const RANGE = 0.3

export function ScaleSlider() {
  const tree = useAppStore((s) => s.tree)
  const packing = useAppStore((s) => s.packing)
  const lastSolvedScale = useAppStore((s) => s.lastSolvedScale)
  const setPackingScale = useAppStore((s) => s.setPackingScale)
  const [multiplier, setMultiplier] = useState(1)

  useEffect(() => {
    setMultiplier(1)
  }, [lastSolvedScale])

  if (!packing || lastSolvedScale == null) return null
  const stale = isPackingStale(tree, packing)

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const m = Number(e.target.value)
    setMultiplier(m)
    setPackingScale(lastSolvedScale * m)
  }

  return (
    <label className="scale-slider" title="Scale octagons/rivers up or down around the last solve's scale">
      scale
      <input
        type="range"
        min={1 - RANGE}
        max={1 + RANGE}
        step={0.01}
        value={multiplier}
        disabled={stale}
        onChange={onChange}
      />
      <span className="scale-slider-value">{packing.scale.toFixed(4)}</span>
    </label>
  )
}
