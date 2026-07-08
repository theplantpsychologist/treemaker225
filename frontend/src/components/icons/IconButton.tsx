import { useEffect, useRef } from 'react'
import './IconButton.css'

interface IconButtonProps {
  icon: string
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  className?: string
}

/** A single monochrome SVG asset recolored via CSS mask-image +
 * background-color, so one icon file works across normal/hover/active/
 * disabled button states without separate per-state art (see the
 * "Styling organization" README section). The `--icon-src` custom property
 * (read by `var(--icon-src)` in IconButton.css) is set imperatively via a
 * ref rather than through the React `style` prop — this React/build
 * combination silently drops custom-property style keys passed through
 * the declarative style object, while a direct `style.setProperty` call
 * on the DOM node always works. */
export function IconButton({ icon, label, onClick, active, disabled, className }: IconButtonProps) {
  const glyphRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    glyphRef.current?.style.setProperty('--icon-src', `url("${icon}")`)
  }, [icon])

  return (
    <button
      type="button"
      className={'icon-button' + (active ? ' active' : '') + (className ? ` ${className}` : '')}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <span ref={glyphRef} className="icon-button-glyph" />
    </button>
  )
}
