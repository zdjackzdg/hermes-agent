/**
 * Per-block copy affordance (design pass piece 2). Layers:
 *   1. pure: copyBlock writes the SOURCE through the injectable writer and
 *      flashes "Copied" via the notify seam (the store's hint line).
 *   2. frames: a quiet `⧉` chip trails settled assistant text blocks and user
 *      prompts (never system rows, never a still-streaming block); clicking it
 *      through the real mouse path copies that block's source and the hint
 *      line shows "Copied".
 */
import { afterEach, describe, expect, test } from 'vitest'

import { copyBlock, setBlockClipboardWriter } from '../logic/blockCopy.ts'
import { registerNotifier } from '../logic/notify.ts'
import { createSessionStore } from '../logic/store.ts'
import { App } from '../view/App.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

type Store = ReturnType<typeof createSessionStore>

afterEach(() => {
  setBlockClipboardWriter() // restore the real clipboard writer
  registerNotifier(undefined)
})

async function mountApp(store: Store, width = 80, height = 30): Promise<RenderProbe> {
  return renderProbe(
    () => (
      <ThemeProvider theme={() => store.state.theme}>
        <App store={store} />
      </ThemeProvider>
    ),
    { height, width }
  )
}

/** Click the `⧉` chip on the frame row that contains `anchor`. */
async function clickChipNear(probe: RenderProbe, anchor: string): Promise<void> {
  const frame = await probe.waitForFrame(f => f.includes(anchor) && f.includes('⧉'))
  const rows = frame.split('\n')
  const y = rows.findIndex(line => line.includes(anchor) && line.includes('⧉'))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = (rows[y] ?? '').indexOf('⧉')
  await probe.click(x, y)
}

describe('copyBlock — pure copy + feedback', () => {
  test('writes the trimmed source through the writer and flashes Copied', () => {
    const writes: string[] = []
    const notices: Array<string | undefined> = []
    setBlockClipboardWriter(text => writes.push(text))
    registerNotifier(text => notices.push(text))
    expect(copyBlock('  # Title\n\nthe *source* text  ')).toBe(true)
    expect(writes).toEqual(['# Title\n\nthe *source* text'])
    expect(notices[0]).toBe('Copied')
  })

  test('an empty block copies nothing and flashes nothing', () => {
    const writes: string[] = []
    const notices: Array<string | undefined> = []
    setBlockClipboardWriter(text => writes.push(text))
    registerNotifier(text => notices.push(text))
    expect(copyBlock('   ')).toBe(false)
    expect(writes).toEqual([])
    expect(notices).toEqual([])
  })
})

describe('store — the notify seam rides the hint line', () => {
  test('createSessionStore registers its setHint; flashNotice lands in state.hint', () => {
    const store = createSessionStore()
    setBlockClipboardWriter(() => {})
    copyBlock('anything')
    expect(store.state.hint).toBe('Copied')
  })
})

describe('⧉ chip frames — quiet chrome, source-true copy', () => {
  test('clicking the chip on a user prompt copies the prompt source + shows Copied', async () => {
    const writes: string[] = []
    setBlockClipboardWriter(text => writes.push(text))
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.pushUser('please *fix* the build')
    const probe = await mountApp(store)
    try {
      await clickChipNear(probe, 'please')
      expect(writes).toEqual(['please *fix* the build'])
      expect(store.state.hint).toBe('Copied')
      const frame = await probe.waitForFrame(f => f.includes('Copied'))
      expect(frame).toContain('Copied')
    } finally {
      probe.destroy()
    }
  })

  test('a settled assistant text block carries a chip; clicking copies the MARKDOWN SOURCE', async () => {
    const writes: string[] = []
    setBlockClipboardWriter(text => writes.push(text))
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ payload: { text: 'the **bold** answer' }, type: 'message.delta' })
    store.apply({ type: 'message.complete' })
    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(f => f.includes('⧉'))
      expect(frame).toContain('⧉')
      const rows = frame.split('\n')
      const y = rows.findIndex(line => line.includes('⧉'))
      const x = (rows[y] ?? '').indexOf('⧉')
      await probe.click(x, y)
      // SOURCE, not the concealed rendered text: the ** markers survive.
      expect(writes).toEqual(['the **bold** answer'])
    } finally {
      probe.destroy()
    }
  })

  test('no chip while the turn is still streaming; it appears on settle', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'message.start' })
    store.apply({ payload: { text: 'streaming words' }, type: 'message.delta' })
    const probe = await mountApp(store)
    try {
      // (markdown BODY text doesn't paint in headless char frames — assert on
      // the chip itself, which is a plain-text renderable)
      await probe.settle()
      expect(probe.frame()).not.toContain('⧉')
      store.apply({ type: 'message.complete' })
      const settled = await probe.waitForFrame(f => f.includes('⧉'))
      expect(settled).toContain('⧉')
    } finally {
      probe.destroy()
    }
  })

  test('system rows get no chip (chrome, nothing to copy)', async () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.pushSystem('gateway notice line')
    const probe = await mountApp(store)
    try {
      const frame = await probe.waitForFrame(f => f.includes('gateway notice line'))
      expect(frame).not.toContain('⧉')
    } finally {
      probe.destroy()
    }
  })
})
