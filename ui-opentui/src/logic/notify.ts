/**
 * Transient-notice seam (per-block copy feedback, Epic: design pass piece 2).
 * Deep view nodes (e.g. the per-block `⧉` copy affordance in messageLine) need
 * to flash a short notice ("Copied") on the EXISTING hint line (StatusLine —
 * the same surface the entry's flashHint uses for /copy and selection-copy),
 * but they don't hold the store. The store registers its `setHint` here at
 * creation (one live store per app; the latest registration wins, which is
 * also what headless tests want), and `flashNotice` mirrors the entry's
 * flashHint contract: set, then auto-clear after `ms` unless something newer
 * replaced it. No-op when nothing is registered (bare component tests).
 */

type NotifySink = (text: string | undefined) => void

let sink: NotifySink | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let current: string | undefined

/** Register (or clear) the app-wide notice sink — the store's `setHint`. */
export function registerNotifier(fn: NotifySink | undefined): void {
  sink = fn
}

/** Flash a transient notice on the hint line; auto-clears after `ms`. */
export function flashNotice(text: string, ms = 1500): void {
  sink?.(text)
  current = text
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    if (current === text) {
      sink?.(undefined)
      current = undefined
    }
  }, ms)
}
