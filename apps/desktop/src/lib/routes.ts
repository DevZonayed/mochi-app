/* Single source of truth for desktop navigation.

   The sidebar and the active-item highlight both derive from this list, and
   every `path` here maps to a real <Route> in App.tsx. This is what fixes the
   original bug where the sidebar navigated to keys (`/home`, `/jobs`) that had
   no matching route and rendered a blank screen. */

import type { IconName } from './icons';

export interface NavRoute {
  key: string;
  path: string;
  label: string;
  icon: IconName;
  badge?: number;
}

export const NAV_ROUTES: NavRoute[] = [
  { key: 'home', path: '/command-center', label: 'Home', icon: 'home' },
  { key: 'workspace', path: '/workspace', label: 'CodeSpace', icon: 'terminal' },
  { key: 'design', path: '/design-workspace', label: 'Design', icon: 'brush' },
  { key: 'projects', path: '/projects', label: 'Projects', icon: 'layers' },
  { key: 'jobs', path: '/job-monitor', label: 'Jobs', icon: 'jobs' },
  { key: 'approvals', path: '/approvals', label: 'Approvals', icon: 'shield' },
  { key: 'scheduler', path: '/scheduler', label: 'Scheduler', icon: 'calendar' },
  { key: 'skills', path: '/skills-registry', label: 'Skills', icon: 'spark' },
  { key: 'templates', path: '/templates', label: 'Templates', icon: 'sliders' },
  { key: 'trends', path: '/trends', label: 'Trends', icon: 'telescope' },
  { key: 'studio', path: '/media-studio', label: 'Studio', icon: 'clapper' },
  { key: 'publishing', path: '/publishing', label: 'Publishing', icon: 'send' },
  { key: 'comms', path: '/comms', label: 'Comms', icon: 'command' },
  { key: 'budget', path: '/budget', label: 'Costs', icon: 'gauge' },
];

export const SETTINGS_ROUTE: NavRoute = { key: 'settings', path: '/settings', label: 'Settings', icon: 'settings' };

/** Feedback inbox — reached from the chrome's feedback button (not a standing
    sidebar item), but registered so pathForNav('feedback') + active highlighting resolve. */
export const FEEDBACK_ROUTE: NavRoute = { key: 'feedback', path: '/feedback', label: 'Feedback', icon: 'feedback' };

/** Every navigable destination (sidebar items + pinned Settings + Feedback), for active-key lookup. */
export const ALL_NAV: NavRoute[] = [...NAV_ROUTES, SETTINGS_ROUTE, FEEDBACK_ROUTE];

/** Coding-genre navigation. Both genres now LEAD with the Workspace (CodeSpace)
    and Design pair so the operator can cross between code and design from either
    header. Costs and Skills are intentionally NOT here — they live in the Settings
    page and in each project's settings tabs, not as standing top-nav menus. Home,
    Projects, Trends and Approvals are hidden too (Approvals surfaces as a bell only
    when a gate is actually pending). Every route stays registered in App.tsx, so
    dropping a key here hides the menu without breaking the route. */
export const CODING_NAV: NavRoute[] = (['workspace', 'design', 'jobs', 'scheduler', 'templates'] as const)
  .map(k => NAV_ROUTES.find(r => r.key === k))
  .filter((r): r is NavRoute => !!r);

/** Design-genre navigation — same Workspace + Design lead, plus the media Studio
    a designer reaches for. Projects, Trends and Costs are dropped (Costs lives in
    Settings; Projects/Trends are hidden for now). */
export const DESIGN_NAV: NavRoute[] = (['workspace', 'design', 'studio'] as const)
  .map(k => NAV_ROUTES.find(r => r.key === k))
  .filter((r): r is NavRoute => !!r);

/** Nav key → real route path. Keys and paths differ ('jobs' → '/job-monitor');
    guessing '/' + key sends mismatched keys into the router's catch-all (Home).
    Every onNav handler must resolve through this. */
export function pathForNav(key: string): string {
  return ALL_NAV.find(r => r.key === key)?.path ?? '/' + key;
}
