import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import Launcher from './screens/Launcher';

const Onboarding = React.lazy(() => import('./screens/Onboarding'));
const CommandCenter = React.lazy(() => import('./screens/CommandCenter'));
const Projects = React.lazy(() => import('./screens/Projects'));
const ProjectDetail = React.lazy(() => import('./screens/ProjectDetail'));
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
const DevicePairing = React.lazy(() => import('./screens/DevicePairing'));
const AuditHistory = React.lazy(() => import('./screens/AuditHistory'));

export function App() {
  return (
    <HashRouter>
      <React.Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Launcher />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/command-center" element={<CommandCenter />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/project-detail" element={<ProjectDetail />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/job-monitor" element={<JobMonitor />} />
          <Route path="/session-transcript" element={<SessionTranscript />} />
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
          <Route path="/device-pairing" element={<DevicePairing />} />
          <Route path="/audit" element={<AuditHistory />} />
        </Routes>
      </React.Suspense>
    </HashRouter>
  );
}
