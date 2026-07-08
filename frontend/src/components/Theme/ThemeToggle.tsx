import { useEffect, useState } from 'react'
import { IconButton } from '../icons/IconButton'
import lightDarkIcon from '../../assets/light-dark.svg'

function getInitialTheme(): 'light' | 'dark' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return (
    <IconButton
      icon={lightDarkIcon}
      label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      active={theme === 'dark'}
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
    />
  )
}
