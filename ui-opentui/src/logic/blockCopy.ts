/**
 * Per-block copy (design pass piece 2) — the `⧉` affordance on each assistant
 * response text block / user prompt copies that block's SOURCE text (the
 * markdown source held in the store part, NOT the concealed rendered text —
 * the same source the `/copy` command resolves via logic/copy.ts, scoped to
 * one block). The write goes through the existing boundary clipboard (OSC 52 +
 * native command) and feedback rides the existing hint line via flashNotice.
 *
 * The writer is injectable so headless tests never spawn xclip/wl-copy or
 * touch the developer's real clipboard.
 */
import { writeClipboard } from '../boundary/clipboard.ts'
import { flashNotice } from './notify.ts'

type ClipboardWriter = (text: string) => unknown

const defaultWriter: ClipboardWriter = text => void writeClipboard(text)
let writer: ClipboardWriter = defaultWriter

/** Test seam: swap (or restore, with no argument) the clipboard writer. */
export function setBlockClipboardWriter(fn?: ClipboardWriter): void {
  writer = fn ?? defaultWriter
}

/** Copy one block's source text; flashes "Copied" on success. False when empty. */
export function copyBlock(text: string): boolean {
  const source = (text ?? '').trim()
  if (!source) return false
  writer(source)
  flashNotice('Copied')
  return true
}
