import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export type DropdownOption = {
  value: string
  label: string
  disabled?: boolean
}

/**
 * Custom inline dropdown (Batch 13, 2026-11-25) — the wizard's
 * replacement for every native <select>.
 *
 * Why: on Android Chrome a native <select> opens the OS full-screen
 * picker, which the user found confusing. This list opens INLINE,
 * directly BELOW the button, inside the page flow — never a modal,
 * never a full-screen sheet. Long lists (e.g. the 30+ caption
 * languages) scroll INSIDE the list (max-height + overflow), never
 * pushing the page around.
 *
 * Behaviour: tap the button to open/close; tap an option to select
 * it and close; tap outside or press Escape to close; arrow keys
 * move through the options, Enter selects, Escape closes. The
 * button shows the current value + a chevron that rotates when
 * open. Values, defaults and submitted payloads are unchanged —
 * this is a control replacement only.
 */
export function Dropdown({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  disabled?: boolean
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()

  const selected = options.find((o) => o.value === value)
  const enabledOptions = options.filter((o) => !o.disabled)

  // Close on an outside tap or Escape (Escape also returns focus
  // to the button, so keyboard users do not lose their place).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open ])

  // Keep the active (keyboard-highlighted) option visible inside
  // the scrolling list.
  useEffect(() => {
    if (!open || active < 0) return
    const el = listRef.current?.querySelector(`[data-option-index="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const pick = (opt: DropdownOption) => {
    if (opt.disabled) return
    onChange(opt.value)
    setOpen(false)
    buttonRef.current?.focus()
  }

  const moveActive = (dir: 1 | -1) => {
    if (enabledOptions.length === 0) return
    const current = active < 0 ? options.indexOf(enabledOptions[0]) : active
    let next = current
    for (let i = 0; i < options.length; i++) {
      next = (next + dir + options.length) % options.length
      if (!options[next].disabled) break
    }
    setActive(next)
  }

  const onButtonKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        setActive(options.findIndex((o) => o.value === value && !o.disabled))
      } else {
        moveActive(e.key === 'ArrowDown' ? 1 : -1)
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (open && active >= 0 && options[active] && !options[active].disabled) {
        pick(options[active])
      } else {
        setOpen((v) => !v)
      }
    }
  }

  return (
    <div ref={rootRef} className="relative mt-2">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (disabled) return
          setOpen((v) => !v)
          if (!open) {
            setActive(options.findIndex((o) => o.value === value && !o.disabled))
          }
        }}
        onKeyDown={onButtonKeyDown}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-ink-border bg-ink-panel2 px-3 py-2.5 text-left text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="min-w-0 truncate">{selected ? selected.label : value}</span>
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-ink-border bg-ink-panel2 py-1 shadow-lg"
        >
          {options.map((opt, i) => {
            const isSelected = opt.value === value
            const isActive = i === active
            return (
              <li
                key={opt.value}
                data-option-index={i}
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled || undefined}
                onClick={() => pick(opt)}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm ${
                  opt.disabled
                    ? 'cursor-not-allowed opacity-50'
                    : isActive
                      ? 'bg-white/10 text-white'
                      : 'text-white/90'
                }`}
              >
                <span className="min-w-0 truncate">{opt.label}</span>
                {isSelected ? (
                  <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-brand-light" />
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
