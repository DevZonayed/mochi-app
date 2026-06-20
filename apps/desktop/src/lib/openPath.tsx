/* OpenPathContext — when a path in chat is clicked, route it through the
   active container (Workspace) so it opens as an in-app file/image TAB
   instead of just revealing in Finder.

   The value is a function `(path) => void`. ChatThread sets it to a smart
   wrapper that opens an in-app tab when the path is inside the current
   project (so it can be edited/previewed/copied), and falls back to
   reveal-in-Finder for paths outside the project. When no value is
   provided (e.g. ChatThread rendered standalone in ProjectDetail), the
   PathLink falls back to reveal-in-Finder. */

import React from 'react';

export type OpenPathFn = (path: string) => void;

/** Null when there's no host to receive opens — PathLink then reveals in Finder. */
export const OpenPathContext = React.createContext<OpenPathFn | null>(null);

/** True when `abs` is `root` itself or lives below it. Tolerates trailing slashes. */
export function pathIsInside(abs: string, root: string): boolean {
  if (!abs || !root) return false;
  const a = abs.replace(/\/+$/, '');
  const r = root.replace(/\/+$/, '');
  return a === r || a.startsWith(r + '/');
}
