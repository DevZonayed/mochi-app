/**
 * ControllerContext — shared React context for the controller tab screens.
 * Separated from ControllerTabs to avoid circular imports (ControllerTabs
 * imports the tab screens, and the tab screens import this context hook).
 */
import React from 'react';
import type { ShadowUiState } from '../../shadowUiModel';
import type { ShadowUiController } from '../../shadowUiController';

export interface ControllerContextValue {
  state: ShadowUiState;
  controller: ShadowUiController;
}

const Ctx = React.createContext<ControllerContextValue | null>(null);

/** Access the shared controller state + projection from any tab screen. */
export function useController(): ControllerContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useController must be used within ControllerProvider');
  return ctx;
}

export const ControllerProvider = Ctx.Provider;
