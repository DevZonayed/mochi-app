import React from 'react';
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { UpdateBanner } from './lib/UpdateBanner';
import { NotificationCenter } from './lib/notify';
import { RemotePairGate } from './lib/RemotePairGate';
import { ErrorBoundary } from './lib/ErrorBoundary';
import { PrActionConfirmDialog } from './screens/PrActionConfirmDialog';
import { ExitPlanModeDialog } from './screens/ExitPlanModeDialog';
import { IS_LOCAL } from './lib/api';
import { hasSession, onAuthChange, primeSession } from './lib/auth';

/* Real application entry. First run → Onboarding (creates the workspace, sets
   the budget); afterwards the app opens straight in the Workspace. There is no
   separate home/dashboard screen — the Workspace is home. The old "Launcher"
   gallery was Claude Design's screen index — a design-tool artifact — and is no
   longer part of the product. */

const Onboarding = React.lazy(() => import('./screens/Onboarding'));
const Projects = React.lazy(() => import('./screens/Projects'));
const ProjectDetail = React.lazy(() => import('./screens/ProjectDetail'));
const Workspace = React.lazy(() => import('./screens/Workspace'));
const DesignWorkspace = React.lazy(() => import('./screens/DesignWorkspace'));
const JobMonitor = React.lazy(() => import('./screens/JobMonitor'));
const SessionTranscript = React.lazy(() => import('./screens/SessionTranscript'));
const Scheduler = React.lazy(() => import('./screens/Scheduler'));
const PlanDiffGate = React.lazy(() => import('./screens/PlanDiffGate'));
const ApprovalsCenter = React.lazy(() => import('./screens/ApprovalsCenter'));
const SkillsRegistry = React.lazy(() => import('./screens/SkillsRegistry'));
const McpGateway = React.lazy(() => import('./screens/McpGateway'));
const MediaStudio = React.lazy(() => import('./screens/MediaStudio'));
const PublishingCenter = React.lazy(() => import('./screens/PublishingCenter'));
const TrendIntelligence = React.lazy(() => import('./screens/TrendIntelligence'));
const CommsGateway = React.lazy(() => import('./screens/CommsGateway'));
const WhatsApp = React.lazy(() => import('./screens/WhatsApp'));
const BudgetDashboard = React.lazy(() => import('./screens/BudgetDashboard'));
const Settings = React.lazy(() => import('./screens/Settings'));
const Feedback = React.lazy(() => import('./screens/Feedback'));
const Login = React.lazy(() => import('./screens/Login'));
const AuditHistory = React.lazy(() => import('./screens/AuditHistory'));

/** Where the app should land: first-run setup, or straight into the cockpit —
    the Design genre opens on its canvas, everything else on the Workspace. */
function entryPath(): string {
  try {
    if (localStorage.getItem('maestro.onboarded') !== '1') return '/onboarding';
    return localStorage.getItem('maestro.purpose') === 'design' ? '/design-workspace' : '/workspace';
  } catch {
    return '/onboarding';
  }
}

/* Account gate (desktop only). The Maestro desktop now requires an account
   session: until the operator signs in, show the Login screen; the host
   connection to the server only starts once a session token exists (pushed to
   main from the auth lib). The web build (!IS_LOCAL) keeps its own token-based
   RemotePairGate path and skips this entirely. */
function AccountGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = React.useState(() => hasSession());
  React.useEffect(() => {
    if (!IS_LOCAL) return;
    // Push any stored session to main on launch so the host reconnects without
    // forcing a re-login, then track login/logout to re-render the gate.
    primeSession();
    return onAuthChange(() => setAuthed(hasSession()));
  }, []);
  if (IS_LOCAL && !authed) {
    return (
      <React.Suspense fallback={null}>
        <Login />
      </React.Suspense>
    );
  }
  return <>{children}</>;
}

/* Bridges native macOS menu commands into the SPA router. The WebKit shell's
   App menu fires `window.dispatchEvent(new CustomEvent('maestro:open-settings'))`
   on ⌘, ; here we turn that into a route change so the standard Settings
   shortcut works like a native app. Must live inside <HashRouter> for
   useNavigate(). */
function NativeMenuBridge() {
  const navigate = useNavigate();
  React.useEffect(() => {
    const openSettings = () => navigate('/settings');
    window.addEventListener('maestro:open-settings', openSettings);
    return () => window.removeEventListener('maestro:open-settings', openSettings);
  }, [navigate]);
  return null;
}

export function App() {
  return (
    <HashRouter>
      <NativeMenuBridge />
      <AccountGate>
      <RemotePairGate>
      <ErrorBoundary name="app">
      <React.Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Navigate to={entryPath()} replace />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/design-workspace" element={<DesignWorkspace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/project-detail" element={<ProjectDetail />} />
          <Route path="/project-detail/:id" element={<ProjectDetail />} />
          <Route path="/job-monitor" element={<JobMonitor />} />
          <Route path="/session-transcript" element={<SessionTranscript />} />
          <Route path="/session-transcript/:id" element={<SessionTranscript />} />
          <Route path="/scheduler" element={<Scheduler />} />
          <Route path="/plan-diff-gate" element={<PlanDiffGate />} />
          <Route path="/approvals" element={<ApprovalsCenter />} />
          <Route path="/skills-registry" element={<SkillsRegistry />} />
          <Route path="/mcp-gateway" element={<McpGateway />} />
          <Route path="/media-studio" element={<MediaStudio />} />
          <Route path="/publishing" element={<PublishingCenter />} />
          <Route path="/trends" element={<TrendIntelligence />} />
          <Route path="/comms" element={<CommsGateway />} />
          <Route path="/whatsapp" element={<WhatsApp />} />
          <Route path="/budget" element={<BudgetDashboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/feedback" element={<Feedback />} />
          <Route path="/audit" element={<AuditHistory />} />
          <Route path="*" element={<Navigate to={entryPath()} replace />} />
        </Routes>
      </React.Suspense>
      </ErrorBoundary>
      <UpdateBanner />
      <NotificationCenter />
      {/* Mac-local: hard-button gate for the agent's pr_merge / pr_resolve_conflicts.
          Subscribes to `pr-confirm-request` events and re-invokes the existing
          mergeSessionPR / resolveSession IPC handlers after a HUMAN click. */}
      {IS_LOCAL && <PrActionConfirmDialog />}
      {/* Mac-local: plan-mode exit gate. The agent's ExitPlanMode call parks on
          the host's canUseTool callback (electron/plan-mode-gate.ts); the
          renderer subscribes to `plan-mode-exit-request` here, shows a modal
          with the plan body, and resolves the parked request when the operator
          clicks Approve or Keep Planning. Without this, plan mode was a dead
          end — the agent never got the approval it was waiting on. */}
      {IS_LOCAL && <ExitPlanModeDialog />}
      </RemotePairGate>
      </AccountGate>
    </HashRouter>
  );
}
