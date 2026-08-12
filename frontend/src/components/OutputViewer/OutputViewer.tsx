import './OutputViewer.css'

/** Placeholder for the rendered crease pattern -- populated once
 * "Render crease pattern" (`RenderCreasePatternButton.tsx`) does real work. */
export function OutputViewer() {
  return (
    <div className="output-viewer-empty">
      Nothing rendered yet -- reach 0 degrees of freedom in the tiling editor, then "Render crease pattern".
    </div>
  )
}
