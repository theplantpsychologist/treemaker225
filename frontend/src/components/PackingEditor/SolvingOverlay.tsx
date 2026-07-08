import { useAppStore } from '../../state/store'
import robotLoading from '../../assets/robot_loading.svg'
import './SolvingOverlay.css'

/** Covers the packing canvas with the animated robot while a solve is in
 * flight, so it's obvious the (potentially multi-second) restart search is
 * running rather than the UI having stalled. */
export function SolvingOverlay() {
  const solving = useAppStore((s) => s.solving)
  if (!solving) return null
  return (
    <div className="solving-overlay">
      <img src={robotLoading} alt="Solving…" className="solving-overlay-robot" />
      <span>Solving…</span>
    </div>
  )
}
