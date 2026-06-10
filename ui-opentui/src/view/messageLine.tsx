/**
 * MessageLine — renders one transcript row (spec v4 §2 / §7). An assistant turn
 * is ONE ordered `parts[]` dispatched by `<Switch>`/`<Match>` on `part.type`, so
 * text / reasoning / tool interleave INLINE (the §7 fix for "tools dump below").
 * User/system rows (and settled/resumed assistant rows with no parts) render flat
 * `text`. Fully themed; rich text via <b>/<span>, never an attributes bitmask (§8 #1).
 *
 * Visual hierarchy (design pass, Appendix C): the view is a dark room and gold
 * is the single lamp — it sits on the NEWEST answer's `⚕` and the user's `❯`,
 * nowhere else (older assistant glyphs demote to grey: they merely happened).
 * The user's prompt BODY is muted (your words are context; the answer is the
 * reward) and the turn is set off by MORE blank space than the parts inside a
 * turn (turn boundary > part gap — see `turnSpacing`). Once a turn settles,
 * interstitial narration text demotes to muted and only the FINAL text block
 * keeps the full-bright answer color (see `lastTextId`).
 *
 * Per-block copy (piece 2): every settled assistant text block and every user
 * prompt carries a quiet `⧉` chip at its top-right — muted chrome
 * (selectable=false) that disappears into the frame until wanted. Click →
 * copies that block's SOURCE text (the markdown source in the store, same as
 * `/copy` — not the concealed rendered text) via logic/blockCopy and flashes
 * "Copied" on the existing hint line.
 *
 * Stable `id` per part as the <For> key so a new tool part below a streaming text
 * part doesn't remount it.
 */
import { For, Match, Show, Switch } from 'solid-js'

import { copyBlock } from '../logic/blockCopy.ts'
import { collapseHiddenParts, hiddenRunLabel } from '../logic/details.ts'
import type { Message, Part } from '../logic/store.ts'
import type { ThemeColors } from '../logic/theme.ts'
import { useDisplay } from './display.tsx'
import { Markdown } from './markdown.tsx'
import { ReasoningPart } from './reasoningPart.tsx'
import { useTheme } from './theme.tsx'
import { ToolPart } from './toolPart.tsx'

const GUTTER = 2

/**
 * Per-turn vertical margins (pure — table-tested). Turn boundary > part gap:
 * a USER turn gets a blank line above AND below (top 2 + bottom 1; with the
 * next turn's own top 1 the boundary around a prompt is 2 rows vs the 1-row
 * part gap), so prompts read as section breaks from across the room. /compact
 * collapses everything to 0.
 */
export function turnSpacing(role: Message['role'], compact: boolean): { top: number; bottom: number } {
  if (compact) return { bottom: 0, top: 0 }
  if (role === 'user') return { bottom: 1, top: 2 }
  return { bottom: 0, top: 1 }
}

/**
 * Role-glyph color (pure — table-tested). Gold is EARNED: the user's `❯` and
 * the NEWEST answer's `⚕` are primary; an older assistant glyph demotes to
 * grey (it merely happened); system notes stay dim.
 */
export function glyphColor(role: Message['role'], latest: boolean, color: ThemeColors): string {
  if (role === 'user') return color.primary
  if (role === 'assistant') return latest ? color.primary : color.muted
  return color.muted
}

/**
 * Flat-body color (pure — table-tested). The assistant's answer is the ONLY
 * full-bright prose; the user's words are context (muted), system notes dim.
 */
export function bodyColor(role: Message['role'], color: ThemeColors): string {
  return role === 'assistant' ? color.text : color.muted
}

/**
 * The id of a turn's FINAL text part — the answer that keeps full-bright text
 * once the turn settles; earlier (interstitial) text parts were play-by-play
 * scaffolding and demote to muted. Pure — exported for tests.
 */
export function lastTextId(parts: readonly Part[] | undefined): string | undefined {
  if (!parts) return undefined
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p && p.type === 'text') return p.id
  }
  return undefined
}

/**
 * The quiet per-block copy chip — muted `⧉` chrome at a block's top-right.
 * Click copies the block's SOURCE (markdown source / prompt text) and flashes
 * "Copied". selectable=false: it must never ride along in a drag-selection.
 */
function CopyChip(props: { source: () => string }) {
  const theme = useTheme()
  return (
    <box style={{ flexShrink: 0, marginLeft: 1 }} onMouseDown={() => copyBlock(props.source())}>
      <text selectable={false}>
        <span style={{ fg: theme().color.muted }}>⧉</span>
      </text>
    </box>
  )
}

export function MessageLine(props: { message: Message; latest?: boolean }) {
  const theme = useTheme()
  const display = useDisplay()
  const m = () => props.message
  const glyph = () => (m().role === 'assistant' ? theme().brand.icon : m().role === 'user' ? theme().brand.prompt : '·')
  const glyphFg = () => glyphColor(m().role, props.latest ?? false, theme().color)
  const bodyFg = () => bodyColor(m().role, theme().color)
  const hasParts = () => (m().parts?.length ?? 0) > 0
  const spacing = () => turnSpacing(m().role, display().compact)
  // /details hidden: fold each run of tool/reasoning parts into ONE muted line
  // (the parts stay in the store — flipping the mode back restores them).
  const displayParts = () => (display().details === 'hidden' ? collapseHiddenParts(m().parts ?? []) : (m().parts ?? []))
  // Settled-turn narration demotion: once the turn stops streaming, every text
  // part EXCEPT the final answer drops to muted.
  const textFg = (id: string) =>
    !m().streaming && id !== lastTextId(m().parts) ? theme().color.muted : theme().color.text

  return (
    // Turn-boundary spacing > part gap (see turnSpacing); /compact collapses it
    // so long sessions read denser. The earned-gold glyphs do the rest.
    <box style={{ flexDirection: 'row', flexShrink: 0, marginTop: spacing().top, marginBottom: spacing().bottom }}>
      <box style={{ flexShrink: 0, width: GUTTER }}>
        {/* the role glyph is decorative — exclude it from mouse selection (item 4).
            Bold so the user `❯` / assistant `⚕` turn boundaries pop (item 8). */}
        <text selectable={false}>
          <span style={{ fg: glyphFg() }}>
            <b>{glyph()}</b>
          </span>
        </text>
      </box>
      {/* gap owns ALL inter-part spacing (item 5) — uniform 1 line between text /
          reasoning / tool regardless of order or stream timing, so blank lines
          don't pop in and out as parts are created/merged mid-stream. /compact
          drops the gap along with the per-turn margins above. */}
      <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0, gap: display().compact ? 0 : 1 }}>
        <Show
          when={m().role === 'assistant' && hasParts()}
          fallback={
            // No parts yet: the just-started streaming turn shows ONLY the caret,
            // inline with the glyph (not an empty line + a dangling caret below —
            // item 10 cursor misalignment); a settled row shows its flat text.
            <Show
              when={m().streaming && !hasParts()}
              fallback={
                // themed selection: a solid muted/accent bar that preserves the
                // text fg (no selectionFg → the original color shows through, so a
                // highlight over content reads as a clean bar, not SGR-inverse).
                // A quiet ⧉ chip trails the block (user prompts + settled
                // assistant rows; system notes are chrome, nothing to copy).
                <box style={{ flexDirection: 'row', flexShrink: 0 }}>
                  <box style={{ flexGrow: 1, minWidth: 0 }}>
                    <text selectionBg={theme().color.selectionBg}>
                      <span style={{ fg: bodyFg() }}>{m().text}</span>
                    </text>
                  </box>
                  <Show when={m().role !== 'system' && m().text.trim()}>
                    <CopyChip source={() => m().text} />
                  </Show>
                </box>
              }
            >
              <text selectable={false}>
                {/* streaming caret — a cursor glyph, not content (item 4) */}
                <span style={{ fg: theme().color.muted }}>▍</span>
              </text>
            </Show>
          }
        >
          <For each={displayParts()}>
            {part => (
              <Switch>
                <Match when={part.type === 'tool' && part}>{tool => <ToolPart part={tool()} />}</Match>
                <Match when={part.type === 'reasoning' && part}>
                  {r => <ReasoningPart text={r().text} streaming={m().streaming ?? false} />}
                </Match>
                <Match when={part.type === 'hiddenRun' && part}>
                  {/* /details hidden — the honest minimal render for a folded
                      tool/reasoning run; chrome, not copyable content. */}
                  {run => (
                    <text selectable={false}>
                      <span style={{ fg: theme().color.muted }}>{`⚡ ${hiddenRunLabel(run())}`}</span>
                    </text>
                  )}
                </Match>
                <Match when={part.type === 'text' && part}>
                  {/* ONE stable native <markdown> fed the growing text in place (no
                      per-delta remount → no scrollbar flicker, #2); it renders GFM
                      tables natively (#3). Leading/trailing blanks stripped so the
                      column `gap` is the sole inter-part spacing (item 5).
                      Interstitial narration demotes to muted once settled; a
                      quiet ⧉ copy chip sits at the settled block's top-right. */}
                  {t => (
                    <box style={{ flexDirection: 'row', flexShrink: 0 }}>
                      <box style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
                        <Markdown
                          text={t().text.replace(/^\n+|\n+$/g, '')}
                          streaming={m().streaming ?? false}
                          fg={textFg(t().id)}
                        />
                      </box>
                      <Show when={!m().streaming}>
                        <CopyChip source={() => t().text} />
                      </Show>
                    </box>
                  )}
                </Match>
              </Switch>
            )}
          </For>
        </Show>
      </box>
    </box>
  )
}
