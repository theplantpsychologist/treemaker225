import { useRef } from 'react'
import type { ChangeEvent } from 'react'
import { useAppStore } from '../../state/store'
import './SaveLoadControls.css'

export function SaveLoadControls() {
  const exportSession = useAppStore((s) => s.exportSession)
  const importSession = useAppStore((s) => s.importSession)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const onImportClick = () => fileInputRef.current?.click()

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string)
        importSession(data)
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to import session')
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="save-load-controls">
      <button onClick={exportSession}>Export</button>
      <button onClick={onImportClick}>Import</button>
      <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={onFileChange} />
    </div>
  )
}
