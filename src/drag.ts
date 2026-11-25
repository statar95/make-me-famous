import type { DragEvent } from 'react'

// Native HTML5 drag and drop. Every drag path has a button or picker next to it for keyboards and phones.

export const DRAG_TYPE = 'application/x-mplm-post'

export function startDrag(e: DragEvent, id: string) {
  e.dataTransfer.setData(DRAG_TYPE, id)
  e.dataTransfer.setData('text/plain', id)
  e.dataTransfer.effectAllowed = 'move'
}

export const dragId = (e: DragEvent) => e.dataTransfer.getData(DRAG_TYPE) || null
