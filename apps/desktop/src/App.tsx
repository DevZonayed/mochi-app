import React from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { UpdateBanner } from './lib/UpdateBanner';

/* Real application entry. First run → Onboarding (creates the workspace, sets
   the budget); afterwards the app opens on the Command Center. The old "Launcher"
   gallery was Claude Design's screen index — a design-tool artifact — and is no
   longer part of the product. */

const Onboarding = React.lazy(() => import('./screens/Onboarding'));
const CommandCenter = React.lazy(() => import('./screens/CommandCenter'));
const Projects = React.lazy(() => import('./screens/Projects'));
const ProjectDetail = React.lazy(() => import('./screens/ProjectDetail'));
const Workspace = React.lazy(() => import('./screens/Workspace'));
const DesignWorkspace = React.lazy(() => import('./screens/DesignWorkspace'));
const Templates = React.lazy(() => import('./screens/Templates'));
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
const BudgetDashboard = React.lazy(() => import('./screens/BudgetDashboard'));
const Settings = React.lazy(() => import('./screens/Settings'));
const Feedback = React.lazy(() => import('./screens/Feedback'));
const DevicePairing = React.lazy(() => import('./screens/DevicePairing'));
const AuditHistory = React.lazy(() => import('./screens/AuditHistory'));

/** Where the app should land: first-run setup, or straight into the cockpit —
    the Design genre opens on its canvas, everything else on the Command Center. */
function entryPath(): string {
  try {
    if (localStorage.getItem('maestro.onboarded') !== '1') return '/onboarding';
    return localStorage.getItem('maestro.purpose') === 'design' ? '/design-workspace' : '/command-center';
  } catch {
    return '/onboarding';
  }
}

export function App() {
  return (
    <HashRouter>
      <React.Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Navigate to={entryPath()} replace />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/command-center" element={<CommandCenter />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/design-workspace" element={<DesignWorkspace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/project-detail" element={<ProjectDetail />} />
          <Route path="/project-detail/:id" element={<ProjectDetail />} />
          <Route path="/templates" element={<Templates />} />
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
          <Route path="/budget" element={<BudgetDashboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/feedback" element={<Feedback />} />
          <Route path="/device-pairing" element={<DevicePairing />} />
          <Route path="/audit" element={<AuditHistory />} />
          <Route path="*" element={<Navigate to={entryPath()} replace />} />
        </Routes>
      </React.Suspense>
      <UpdateBanner />
    </HashRouter>
  );
}
