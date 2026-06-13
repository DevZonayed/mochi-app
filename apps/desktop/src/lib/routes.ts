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

/* Primary nav — the operational loop, always visible at the top of the sidebar. */
export const PRIMARY_NAV: NavRoute[] = [
  { key: 'home', path: '/command-center', label: 'Home', icon: 'home' },
  { key: 'workspace', path: '/workspace', label: 'Workspace', icon: 'terminal' },
  { key: 'projects', path: '/projects', label: 'Projects', icon: 'layers' },
  { key: 'jobs', path: '/job-monitor', label: 'Jobs', icon: 'jobs' },
  { key: 'approvals', path: '/approvals', label: 'Approvals', icon: 'shield' },
  { key: 'scheduler', path: '/scheduler', label: 'Scheduler', icon: 'calendar' },
];

/* Secondary nav — supporting tools, demoted into a muted "More" group below the
   primary loop so the sidebar stays minimal. */
export const SECONDARY_NAV: NavRoute[] = [
  { key: 'skills', path: '/skills-registry', label: 'Skills', icon: 'spark' },
  { key: 'templates', path: '/templates', label: 'Templates', icon: 'sliders' },
  { key: 'trends', path: '/trends', label: 'Trends', icon: 'telescope' },
  { key: 'studio', path: '/media-studio', label: 'Studio', icon: 'clapper' },
  { key: 'publishing', path: '/publishing', label: 'Publishing', icon: 'send' },
];

/* Every sidebar item (primary + secondary). Comms & Costs are intentionally
   absent — they're account/config-level and now live inside Settings. */
export const NAV_ROUTES: NavRoute[] = [...PRIMARY_NAV, ...SECONDARY_NAV];

export const SETTINGS_ROUTE: NavRoute = { key: 'settings', path: '/settings', label: 'Settings', icon: 'settings' };

/* Destinations that are reachable (routes + Settings panes) but not shown as
   their own sidebar items — kept here so active-key lookup + pathForNav resolve. */
export const NON_SIDEBAR_NAV: NavRoute[] = [
  { key: 'comms', path: '/comms', label: 'Comms', icon: 'command' },
  { key: 'budget', path: '/budget', label: 'Costs', icon: 'gauge' },
  SETTINGS_ROUTE,
];

/** Every navigable destination, for active-key lookup + route resolution. */
export const ALL_NAV: NavRoute[] = [...NAV_ROUTES, ...NON_SIDEBAR_NAV];

/** Nav key → real route path. Keys and paths differ ('jobs' → '/job-monitor');
    guessing '/' + key sends mismatched keys into the router's catch-all (Home).
    Every onNav handler must resolve through this. */
export function pathForNav(key: string): string {
  return ALL_NAV.find(r => r.key === key)?.path ?? '/' + key;
}
