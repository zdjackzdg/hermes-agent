/**
 * Egg-hatch visuals for the pet generation flow (Cmd-K → Pets → Generate).
 *
 * `PetEggHatch` is the incubation beat shown while `pet.hatch` runs: a wobbling,
 * glowing egg that reads as "something is about to hatch" instead of a bare
 * spinner. `PetHatchSparkles` is the one-shot flash + sparkle burst layered over
 * the revealed sprite. All motion is CSS (see `styles.css`) and is disabled
 * under `prefers-reduced-motion`.
 */

import { type CSSProperties } from 'react'

import { PixelEggSprite } from '@/components/pet/pixel-egg-sprite'
import { Button } from '@/components/ui/button'
import { Sparkles } from '@/lib/icons'

interface PetEggHatchProps {
  subtitle?: string
  onCancel?: () => void
  cancelLabel?: string
}

/**
 * Thin progress bar. Determinate when given done/total (hatch rows stream one by
 * one, so a real percentage is meaningful); indeterminate otherwise (drafts
 * return together, so a count would just snap 0→100).
 */
export function PetProgress({ done, total }: { done?: number; total?: number }) {
  const determinate = typeof done === 'number' && typeof total === 'number' && total > 0
  const pct = determinate ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <div
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={determinate ? pct : undefined}
      className="pet-progress"
      role="progressbar"
    >
      {determinate ? (
        <div className="pet-progress__fill" style={{ width: `${pct}%` }} />
      ) : (
        <div className="pet-progress__indeterminate" />
      )}
    </div>
  )
}

export function PetEggHatch({ subtitle, onCancel, cancelLabel }: PetEggHatchProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-2 py-5">
      <div className="flex flex-col items-center">
        <PixelEggSprite mode="bounce" size={88} />
        <span className="pet-egg-shadow mt-1.5" />
      </div>

      {subtitle && (
        <p className="shimmer max-w-[15rem] text-center text-[length:var(--conversation-caption-font-size)] leading-snug">
          {subtitle}
        </p>
      )}

      {onCancel && (
        <Button onClick={onCancel} size="xs" variant="text">
          {cancelLabel ?? 'Cancel'}
        </Button>
      )}
    </div>
  )
}

// A restrained sparkle burst on reveal — radiating from the sprite center.
const SPARKLES = [
  { sx: '-3rem', sy: '-2.4rem', size: 'size-3', delay: '40ms' },
  { sx: '3.2rem', sy: '-2rem', size: 'size-3.5', delay: '0ms' },
  { sx: '-2.6rem', sy: '2rem', size: 'size-3', delay: '120ms' }
]

/** One-shot flash + sparkle burst, layered over a freshly revealed sprite. */
export function PetHatchSparkles() {
  return (
    <>
      <span className="pet-hatch-flash" />
      {SPARKLES.map((s, i) => (
        <Sparkles
          className={`pet-sparkle ${s.size}`}
          key={i}
          style={{ '--sx': s.sx, '--sy': s.sy, animationDelay: s.delay } as CSSProperties}
        />
      ))}
    </>
  )
}
