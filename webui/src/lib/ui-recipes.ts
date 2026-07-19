/**
 * ui-recipes — the ONE spelling for the class strings that were drifting across
 * the primitive layer (DESIGN_STANDARD §5.1). Import these instead of re-typing
 * the focus ring / floating surface / menu item / modal backdrop by hand so the
 * whole console stays byte-consistent.
 *
 * Rules:
 *  - token-only (no hex, no arbitrary `text-[..]`); every value resolves through
 *    the theme.css design tokens (W0-A).
 *  - composable with `cn()` — pass extra utilities after the recipe.
 *  - a11y: `focusRing` uses `focus-visible` (never bare `focus:`) and an offset so
 *    the ring is visible on any surface; `--ring` is measured ≥3:1 both themes.
 *
 * These are plain strings (not functions) so they inline cleanly into `cn(...)`
 * and into cva base strings.
 */

/**
 * focusRing — the single keyboard-focus treatment. Applied to every interactive
 * primitive (input / textarea / checkbox / switch / radio / slider / select /
 * button / menu triggers). Uses `focus-visible` so pointer clicks don't flash a
 * ring, plus a background-colored offset so the 2px ring reads on any surface.
 */
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-background';

/**
 * overlaySurface — the single floating-portal surface. Consumed by
 * SelectContent / DropdownMenuContent / PopoverContent / HoverCardContent /
 * CommandContent. Popover token pair + overlay shadow + the standard Radix
 * open/close fade+zoom (motion-reduce is handled globally in theme.css).
 */
export const overlaySurface =
  'bg-popover text-popover-foreground rounded-[3px] border border-border shadow-overlay ' +
  'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
  'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 ' +
  'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95';

/**
 * menuItem — the single selectable row inside a menu/command surface. Bridges
 * Radix's `focus:` highlight and cmdk's `data-[selected=true]` so keyboard and
 * mouse selection look identical; `data-[disabled]` dims + blocks pointer events.
 */
export const menuItem =
  'relative flex cursor-default select-none items-center gap-2 rounded-[3px] px-2 py-1.5 text-sm outline-none ' +
  'focus:bg-accent focus:text-accent-foreground data-[selected=true]:bg-accent ' +
  'data-[selected=true]:text-accent-foreground ' +
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

/**
 * modalOverlay — the single dialog/alert/sheet backdrop (was triplicated). A
 * dimmed scrim + a faint blur + the standard fade. `z-50` sits under the modal
 * content (also `z-50`) but above the page.
 */
export const modalOverlay =
  'fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] ' +
  'data-[state=open]:animate-in data-[state=closed]:animate-out ' +
  'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0';
