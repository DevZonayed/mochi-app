/**
 * ControllerScreen — Entry point for the secure controller UI. Subscribes to the
 * single truthful `ShadowUiState` and renders EITHER the enrollment gate (non-content
 * phases) or the new bottom-tab controller UI (online/offline). The store owns all
 * authority + lifecycle + zero-stale-flash gating; this component only picks a view.
 *
 * Phase 4: replaced the old ShadowShell (drawer/sidebar) with ControllerTabs — a
 * proper bottom tab navigator with 5 tabs: Home, Projects, Chat, Screen, More.
 */
import React from 'react';
import { useShadowUi, useShadowUiController } from '../../shadowUiControllerRuntime';
import { projectionVisible } from '../../shadowUiModel';
import { ShadowGate } from './ShadowGate';
import { ControllerTabs } from './ControllerTabs';

export function ControllerScreen() {
  const state = useShadowUi();
  const controller = useShadowUiController();
  if (projectionVisible(state.phase)) return <ControllerTabs state={state} controller={controller} />;
  return <ShadowGate state={state} controller={controller} />;
}

export default ControllerScreen;
