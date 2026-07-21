/**
 * ControllerScreen — Phase 3C2 entry point for the read-only native controller UI.
 * Subscribes to the single truthful `ShadowUiState` (from the observable store wired
 * to the accepted app graph) and renders EITHER the enrollment gate (non-content
 * phases) or the read-only all-project shell (online/offline). The store owns all
 * authority + lifecycle + zero-stale-flash gating; this component only picks a view.
 */
import React from 'react';
import { useShadowUi, useShadowUiController } from '../../shadowUiControllerRuntime';
import { projectionVisible } from '../../shadowUiModel';
import { ShadowGate } from './ShadowGate';
import { ShadowShell } from './ShadowShell';

export function ControllerScreen() {
  const state = useShadowUi();
  const controller = useShadowUiController();
  if (projectionVisible(state.phase)) return <ShadowShell state={state} controller={controller} />;
  return <ShadowGate state={state} controller={controller} />;
}

export default ControllerScreen;
