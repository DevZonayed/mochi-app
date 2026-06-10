# Maestro Desktop Design Library — Export Catalog

Ported from the Babel-standalone design prototype (`design/project/lib/*.jsx`) to
ES-module TypeScript React. Visual output (inline styles, classNames, `var(--…)`
CSS custom properties, SVG geometry, structure) is preserved exactly. Colors and
dimensions are unchanged.

All components render with inline styles that reference CSS custom properties from
the design tokens stylesheet. **Consumers must have `@maestro/design-tokens/tokens.css`
imported once** (already done in `src/main.tsx`), and rely on the prototype's global
CSS for the named `className` hooks (`.effort-btn`, `.model-btn`, `.nav-item`,
`.tb-icon`, `.search-field`, `.ws-header`, `.app-wallpaper`, `.count-up`, the
`spin` keyframes, etc.) and the `--spring`, font, radius, and color tokens.

Three files:

- `src/lib/icons.tsx` — brand mark, provider glyphs, line-icon set
- `src/lib/ui.tsx` — shared UI primitives (imports `Icon` from `./icons`)
- `src/lib/appShell.tsx` — desktop chrome (imports from `./icons`; uses `react-router-dom`)

---

## `src/lib/icons.tsx`

### `type IconName`
Union of every valid `Icon` name (the keys of the internal path map):

```
'check' | 'arrowRight' | 'arrowLeft' | 'folder' | 'lock' | 'key' | 'gauge'
| 'smartphone' | 'sun' | 'moon' | 'spark' | 'shield' | 'bolt' | 'wifi' | 'cpu'
| 'image' | 'dollar' | 'refresh' | 'home' | 'layers' | 'jobs' | 'bell' | 'search'
| 'command' | 'plus' | 'calendar' | 'clock' | 'terminal' | 'brush' | 'play'
| 'telescope' | 'checkCircle' | 'xCircle' | 'more' | 'chevronRight' | 'chevronDown'
| 'gitMerge' | 'send' | 'alert' | 'settings' | 'x' | 'clapper' | 'enter'
| 'sliders' | 'pause'
```

### `interface IconProps`
```ts
{ name: IconName; size?: number; stroke?: number; style?: React.CSSProperties }
```

### `function Icon(props: IconProps)`
Lucide-style 24×24 line icon. Inherits `currentColor`. Renders an `<svg>` with
`fill="none"`, round caps/joins, and the path set selected by `name`.
- `name` — required; one of `IconName`.
- `size` — px width/height. Default `18`.
- `stroke` — stroke width. Default `1.75`.
- `style` — applied to the `<svg>`.

### `function MaestroMark(props: { size?: number })`
The Maestro brand squircle (gradient `#5E8BFF → #7C5CFF → #A24BE0`) with the
conductor/agent-fleet glyph. Uses `React.useId()` for unique gradient IDs.
- `size` — px. Default `96`.

### `function AnthropicGlyph(props: { size?: number })`
Monochrome Anthropic stand-in glyph (40×40 viewBox), inherits `currentColor`.
- `size` — px. Default `26`.

### `function OpenAIGlyph(props: { size?: number })`
Monochrome OpenAI stand-in glyph (40×40 viewBox), inherits `currentColor`.
- `size` — px. Default `26`.

---

## `src/lib/ui.tsx`

> Imports `Icon`, `AnthropicGlyph`, `OpenAIGlyph`, and `IconName` from `./icons`.

### `type PillButtonKind` = `'primary' | 'quiet' | 'plain'`

### `interface PillButtonProps`
```ts
{
  children?: React.ReactNode;
  onClick?: () => void;
  kind?: PillButtonKind;   // default 'primary'
  disabled?: boolean;
  icon?: IconName;         // trailing icon, rendered at size 18
  style?: React.CSSProperties;
}
```

### `function PillButton(props: PillButtonProps)`
44px-tall pill button with press-down spring animation. `primary` is the filled
blue CTA (with disabled state), `quiet` is a borderless blue text button (40px),
`plain` is a neutral `--fill-secondary` button.

### `interface GroupedListProps`
```ts
{ children?: React.ReactNode; header?: React.ReactNode; footer?: React.ReactNode }
```

### `function GroupedList(props: GroupedListProps)`
iOS-style grouped inset container (frosted `--bg-grouped`, `--r-group` radius,
hairline border, `blur(20px)`). Optional uppercase `header` caption and `footer`
note. Put `Row` children inside.

### `interface RowProps`
```ts
{ children?: React.ReactNode; last?: boolean; style?: React.CSSProperties; onClick?: () => void }
```

### `function Row(props: RowProps)`
A single list row (min-height 56px) for use inside `GroupedList`. Draws a hairline
bottom separator unless `last` is set. Becomes a pointer/clickable when `onClick`
is provided.

### `type StatusPillState` = `'idle' | 'waiting' | 'connected' | 'error'`

### `function StatusPill(props: { state: StatusPillState })`
Compact status pill. `connected` shows a check, `waiting` shows a `Spinner`,
others show a colored dot, each with its mapped label/colors:
`idle` → "Not connected", `waiting` → "Waiting for browser…",
`connected` → "Connected", `error` → "Connection failed".

### `interface SpinnerProps`
```ts
{ size?: number; color?: string }   // defaults: size 16, color 'currentColor'
```

### `function Spinner(props: SpinnerProps)`
Circular CSS spinner (uses the `spin` keyframes from the global stylesheet).

### `interface SwitchProps`
```ts
{ on: boolean; onChange: (next: boolean) => void }
```

### `function Switch(props: SwitchProps)`
iOS-style 51×31 toggle. Calls `onChange(!on)` on click.

### Effort dial

#### `type EffortStop` = `'FAST' | 'BALANCED' | 'DEEP' | 'MAX'`

#### `const EFFORT_STOPS: EffortStop[]`
Ordered cycle: `['FAST', 'BALANCED', 'DEEP', 'MAX']`.

#### `const EFFORT_META: Record<EffortStop, { tint: string; bars: number }>`
Per-stop tint color + bar count:
`FAST` → green/1, `BALANCED` → blue/2, `DEEP` → orange/3, `MAX` → red/4.

#### `const EFFORT_EST: Record<EffortStop, { cost: string; mins: string }>`
Pre-run estimate per stop:
`FAST` `{cost:'0.30',mins:'3'}`, `BALANCED` `{cost:'0.60',mins:'6'}`,
`DEEP` `{cost:'1.80',mins:'36'}`, `MAX` `{cost:'3.00',mins:'72'}`.

#### `interface StrengthBarsProps`
```ts
{ level?: number; tint?: string; size?: number }   // defaults: level 2, tint 'var(--blue)', size 15
```

#### `function StrengthBars(props: StrengthBarsProps)`
4 ascending signal bars; the first `level` bars are filled in `tint`, the rest are
faded `--ink-tertiary`.

#### `interface EffortDialProps`
```ts
{ value?: EffortStop; compact?: boolean; onChange?: (next: EffortStop) => void }
```

#### `function EffortDial(props: EffortDialProps)`
Effort selector pill. Renders `StrengthBars` + the stop label in the stop's tint.
**Pass `onChange` to make it interactive** (clicking cycles `FAST → BALANCED →
DEEP → MAX → …` and shows a 4-dot position indicator); omit `onChange` for a
read-only display. `compact` shrinks height 34→28. For `DEEP`/`MAX` it appends a
cost/latency chip (`≈ 3×/5× cost · 6×/12× latency`).

### Model switcher

#### `type ModelProvider` = `'auto' | 'anthropic' | 'openai'`

#### `interface ModelOption`
```ts
{ id: string; name: string; provider: ModelProvider; sub: string; cost: number }
```

#### `const DEFAULT_MODELS: ModelOption[]`
`auto` (cost 0), `opus` (3), `sonnet` (2), `haiku` (1) — all Anthropic except
`auto` — and `gpt` / "GPT-4o" (OpenAI, cost 2).

#### `function ProviderGlyph(props: { provider: ModelProvider; size?: number })`
Renders `AnthropicGlyph` / `OpenAIGlyph` for those providers, else the `cpu` icon
(used for `auto`). `size` default `18`.

#### `function CostDots(props: { n: number })`
Relative-cost indicator: `n === 0` renders the green word "auto"; otherwise 3 dots
with `n` filled in orange.

#### `interface ModelSwitcherProps`
```ts
{
  value?: string;                       // current model id, default 'auto'
  onChange?: (id: string) => void;      // pass to enable the popover
  models?: ModelOption[];               // default DEFAULT_MODELS
  compact?: boolean;
  align?: 'left' | 'right';             // popover edge alignment, default 'left'
}
```

#### `function ModelSwitcher(props: ModelSwitcherProps)`
Pill that opens a pick-from-list popover (provider glyph + tier + relative-cost
dots, with the active item check-marked). **Interactive only when `onChange` is
provided.** Closes on outside-click (document `mousedown` listener while open).
`compact` shrinks the trigger height 34→28.

---

## `src/lib/appShell.tsx`

> Imports `Icon`, `MaestroMark`, and `IconName` from `./icons`, and `useNavigate`
> from `react-router-dom`. **Must be rendered inside a react-router `<Router>`**
> (e.g. `BrowserRouter`/`HashRouter`/`MemoryRouter`) because `AppShell` calls
> `useNavigate()`.

### `const APP_W` = `1320`, `const APP_H` = `860`
Fixed design-canvas dimensions of the macOS window, in px.

### `function useAppScale(pad?: number): number`
`useLayoutEffect` hook returning the scale factor that fits the `APP_W × APP_H`
window into the viewport (capped at 1), re-computed on window resize.
- `pad` — viewport padding subtracted before fitting. Default `40`.

### `type Theme` = `'light' | 'dark'`

### `function useTheme(initial?: Theme): [Theme, React.Dispatch<React.SetStateAction<Theme>>]`
Theme state hook. Writes `document.documentElement.dataset.theme` on change.
- `initial` — default `'light'`.
- Returns `[theme, setTheme]` (the standard `useState` tuple).

### `const WORKSPACE` = `'Atlas Studio'`
Workspace name shown in the sidebar header.

### `interface NavItem`
```ts
{ key: string; icon: IconName; label: string; badge?: number }
```

### `const NAV: NavItem[]`
The sidebar nav model, in order:
`home, projects, jobs, approvals (badge 3), scheduler, skills, templates, trends,
studio, publishing, budget`. Each `key` maps to a route (`"/" + key`); the
`settings` item is rendered separately, pinned at the bottom of the sidebar.

### `function TrafficLights()`
The three macOS window-control dots (`#ff5f57`, `#febc2e`, `#28c840`), absolutely
positioned top-left. No props.

### `interface SidebarProps`
```ts
{ active?: string; onNav?: (key: string) => void; onWorkspace?: () => void }
```

### `function Sidebar(props: SidebarProps)`
260px frosted sidebar: workspace header (`MaestroMark` + `WORKSPACE`), the `NAV`
list (active item highlighted blue, badges shown), and a pinned Settings button.
`onNav` fires with the nav `key` (or `'settings'`); the active item is matched
against `active`. Standalone — `AppShell` wires `onNav` to the router for you.

### `interface BudgetChipProps`
```ts
{ spent: number; cap: number; animateKey?: React.Key }
```

### `function BudgetChip(props: BudgetChipProps)`
Spend/cap chip (`$spent.toFixed(2) / $cap`). Tone escalates ink → orange (≥75%)
→ red (≥90%). `animateKey` is used as the inner `key` to retrigger the `count-up`
animation.

### `interface ToolbarProps`
```ts
{
  onSearch?: () => void;
  budget?: BudgetChipProps;             // renders a BudgetChip when provided
  theme: Theme;
  setTheme: React.Dispatch<React.SetStateAction<Theme>>;
  right?: React.ReactNode;              // custom controls inserted before budget
}
```

### `function Toolbar(props: ToolbarProps)`
56px frosted toolbar: ⌘K search field, a flexible spacer, optional `right` slot,
optional `BudgetChip`, a notifications bell (with unread dot), and an
appearance-toggle button (`moon`/`sun`) that flips `theme` via `setTheme`.

### `interface AppShellProps`
```ts
{
  active?: string;                      // current nav key (highlights sidebar item)
  children?: React.ReactNode;           // page content (rendered in <main>)
  onSearch?: () => void;                // forwarded to Toolbar
  budget?: BudgetChipProps;             // forwarded to Toolbar
  right?: React.ReactNode;              // forwarded to Toolbar
  initialTheme?: Theme;                 // default 'light'; shell owns theme state
  onWorkspace?: () => void;             // workspace-header click
}
```

### `function AppShell(props: AppShellProps)`
The full desktop chrome wrapper used by every page: scaled macOS window
(`useAppScale`) + `TrafficLights` + frosted `Sidebar` + `Toolbar`, with `children`
rendered in a scrollable `<main>`. Owns its own theme state via `useTheme(initialTheme)`.

**Routing:** replaces the prototype's `location.href`-based `navTo`. Clicking a
sidebar item calls `useNavigate()` from `react-router-dom` to route to `"/" + key`
(e.g. nav key `projects` → `/projects`, `settings` → `/settings`). Must be
rendered inside a react-router router. Highlight the active item with the `active`
prop.

Typical use:
```tsx
import { AppShell } from './lib/appShell';

<AppShell active="projects" budget={{ spent: 12.4, cap: 50 }}>
  <ProjectsPage />
</AppShell>
```

---

## Porting notes

- `Object.assign(window, …)` registrations were removed; every symbol is a named
  ES export instead.
- `ProviderGlyph` previously guarded on `window.AnthropicGlyph`/`window.OpenAIGlyph`;
  it now imports those glyphs directly (always available), with identical render output.
- `WindowFrame` (prototype-only, took just `children`) is superseded by `AppShell`,
  which composes the same scaled window + traffic lights and additionally mounts the
  sidebar/toolbar and router navigation. `navTo` is not exported (router replaces it).
- All three files transpile cleanly (verified with esbuild). Full `tsc` requires the
  workspace dependencies to be installed (`react`, `react-router-dom`, `@types/*`).
