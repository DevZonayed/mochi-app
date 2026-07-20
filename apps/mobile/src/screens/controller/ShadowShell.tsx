/**
 * ShadowShell — Phase 3C2 read-only, all-project controller UI. Renders STRICTLY the
 * local `ShadowProjectionView` data (via the gated `controller.projection()`), never a
 * direct server product read. Adaptive: a slide drawer on phones, a persistent sidebar
 * on tablets — preserving the desktop Mochlet IA (Projects → Sessions, Jobs, Approvals,
 * Questions, Schedules, Controller). Phase 3C3 adds the SIX canonical action controls,
 * each rendered ONLY when the verified grant permits + the target is eligible; schedules
 * stay read-only (no canonical schedule command). Every optional field is omitted/neutral.
 */
import React from 'react';
import { View, Text, FlatList, Pressable, useWindowDimensions, ScrollView } from 'react-native';
import { useTheme } from '../../theme';
import { Icon, type IconName } from '../../Icon';
import { signOut } from '../../auth';
import { activeControllerAccountId, deactivateControllerModeForAccount } from '../../controllerMode';
import { signOutSecureController } from '../../controllerRoot';
import { resetProductionShadowController } from '../../shadowProductionController';
import type { ShadowUiState } from '../../shadowUiModel';
import { capabilityLabel } from '../../shadowUiModel';
import type { ShadowUiController } from '../../shadowUiController';
import type { ProjectView, SessionView, JobView, ApprovalView, QuestionView, ScheduleView } from '../../shadowProjectionSelectors';
import { Screen, StatusChip, TapRow, EmptyState, GhostButton, PrimaryButton, idTint, useInsets, type StatusTone } from './parts';
import { ScreenSection } from './ScreenViewer';
import { jobCancellable } from '../../shadowActionModel';
import { grantedActionFamilies } from '../../shadowActionCapabilities';
import {
  ActionEnvProvider, useActionEnv, ActionsNote,
  StartJobControl, CancelJobControl, ApprovalControl, AnswerQuestionControl, SessionActionControls,
} from './ActionControls';

type SectionKey = 'overview' | 'projects' | 'jobs' | 'approvals' | 'questions' | 'schedules' | 'screen' | 'controller';
interface Route { section: SectionKey; projectId?: string; sessionId?: string }

const TABLET_MIN = 768;

const SECTION_META: Record<SectionKey, { label: string; icon: IconName }> = {
  overview: { label: 'Overview', icon: 'home' },
  projects: { label: 'Projects', icon: 'folder' },
  jobs: { label: 'Jobs', icon: 'jobs' },
  approvals: { label: 'Approvals', icon: 'shield' },
  questions: { label: 'Questions', icon: 'chat' },
  schedules: { label: 'Schedules', icon: 'calendar' },
  screen: { label: 'Screen', icon: 'monitor' },
  controller: { label: 'Controller', icon: 'smartphone' },
};

function fmtTime(ms: number | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return null; }
}

/** Bounded, human status tone for a job/approval/question status string. */
function statusTone(status: string | undefined): StatusTone {
  if (status === 'running' || status === 'active') return 'online';
  if (status === 'failed' || status === 'error' || status === 'blocked') return 'locked';
  if (status === 'pending' || status === 'queued') return 'pending';
  return 'neutral';
}

export function ShadowShell({ state, controller }: { state: ShadowUiState; controller: ShadowUiController }) {
  const { theme } = useTheme();
  const insets = useInsets();
  const { width } = useWindowDimensions();
  const tablet = width >= TABLET_MIN;
  const [route, setRoute] = React.useState<Route>({ section: 'overview' });
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const proj = controller.projection();
  const projects = proj.projects();
  const approvals = proj.pendingApprovals();
  const questions = proj.pendingQuestions();
  const schedules = proj.schedules();
  const allJobs = React.useMemo(() => projects.flatMap((p) => proj.projectJobs(p.id)), [projects, proj]);

  // Nav items: core always; Jobs/Questions/Schedules only when the projection has them.
  const navItems: SectionKey[] = ['overview', 'projects'];
  if (allJobs.length > 0) navItems.push('jobs');
  navItems.push('approvals');
  if (questions.length > 0) navItems.push('questions');
  if (schedules.length > 0) navItems.push('schedules');
  navItems.push('screen');
  navItems.push('controller');

  const go = React.useCallback((r: Route) => { setRoute(r); setDrawerOpen(false); }, []);

  const counts: Partial<Record<SectionKey, number>> = {
    projects: projects.length, jobs: allJobs.length, approvals: approvals.length, questions: questions.length, schedules: schedules.length,
  };

  const Nav = (
    <NavList theme={theme} items={navItems} counts={counts} active={route.section} onPick={(s) => go({ section: s })} tablet={tablet} insetsTop={insets.top} />
  );

  const content = (
    <View style={{ flex: 1 }}>
      {!tablet ? (
        <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 12, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 6, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator }}>
          <Pressable onPress={() => setDrawerOpen(true)} accessibilityRole="button" accessibilityLabel="Open menu" hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="layers" size={22} color={theme.color.ink} />
          </Pressable>
          <Text style={{ fontSize: 17, fontWeight: '700', color: theme.color.ink }}>{SECTION_META[route.section].label}</Text>
          <View style={{ flex: 1 }} />
          <ConnBadge state={state} />
        </View>
      ) : null}
      {!state.connection.online ? <OfflineBanner state={state} /> : null}
      <SectionBody route={route} setRoute={go} controller={controller} state={state} bottomInset={insets.bottom} />
    </View>
  );

  // Action controls derive ONLY from the live verified grant + connectivity (no static list).
  const env = { granted: state.enrollment.grantedCapabilities, online: state.connection.online };

  if (tablet) {
    return (
      <ActionEnvProvider granted={env.granted} online={env.online}>
        <Screen>
          <View style={{ flex: 1, flexDirection: 'row' }}>
            <View style={{ width: 264, borderRightWidth: 0.5, borderRightColor: theme.color.separator, backgroundColor: theme.color.bgElevated }}>{Nav}</View>
            {content}
          </View>
        </Screen>
      </ActionEnvProvider>
    );
  }

  return (
    <ActionEnvProvider granted={env.granted} online={env.online}>
      <Screen>
        {content}
        {drawerOpen ? (
          <View style={{ position: 'absolute', inset: 0 as unknown as number, flexDirection: 'row' }} accessibilityViewIsModal>
            <View style={{ width: 288, backgroundColor: theme.color.bgElevated, borderRightWidth: 0.5, borderRightColor: theme.color.separator }}>{Nav}</View>
            <Pressable style={{ flex: 1, backgroundColor: 'rgba(10,12,24,0.45)' }} accessibilityRole="button" accessibilityLabel="Close menu" onPress={() => setDrawerOpen(false)} />
          </View>
        ) : null}
      </Screen>
    </ActionEnvProvider>
  );
}

function NavList({ theme, items, counts, active, onPick, tablet, insetsTop }: {
  theme: ReturnType<typeof useTheme>['theme']; items: SectionKey[]; counts: Partial<Record<SectionKey, number>>;
  active: SectionKey; onPick: (s: SectionKey) => void; tablet: boolean; insetsTop: number;
}) {
  return (
    <ScrollView contentContainerStyle={{ paddingTop: insetsTop + 12, paddingHorizontal: 10, paddingBottom: 20 }}>
      <Text style={{ fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: theme.color.inkTertiary, paddingHorizontal: 12, paddingBottom: 8 }}>{tablet ? 'Controller' : 'Menu'}</Text>
      {items.map((s) => {
        const on = s === active;
        const count = counts[s];
        const meta = SECTION_META[s];
        return (
          <Pressable key={s} onPress={() => onPick(s)} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`${meta.label}${typeof count === 'number' && count > 0 ? `, ${count}` : ''}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46, paddingHorizontal: 12, borderRadius: 10, backgroundColor: on ? theme.color.blue + '18' : 'transparent' }}>
            <Icon name={meta.icon} size={20} color={on ? theme.color.blue : theme.color.inkSecondary} />
            <Text style={{ flex: 1, fontSize: 16, fontWeight: on ? '700' : '500', color: on ? theme.color.blue : theme.color.ink }}>{meta.label}</Text>
            {typeof count === 'number' && count > 0 ? <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.inkTertiary }}>{count}</Text> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ConnBadge({ state }: { state: ShadowUiState }) {
  if (state.connection.online) return <StatusChip tone="online" label="Live" />;
  return <StatusChip tone="offline" label="Offline" />;
}

function OfflineBanner({ state }: { state: ShadowUiState }) {
  const { theme } = useTheme();
  const when = fmtTime(state.connection.lastActivityAt ?? undefined);
  return (
    <View style={{ marginHorizontal: 12, marginTop: 10, padding: 11, borderRadius: 12, backgroundColor: theme.color.orange + '14', borderWidth: 0.5, borderColor: theme.color.orange + '40', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon name="bolt" size={14} color={theme.color.orange} />
      <Text style={{ flex: 1, fontSize: 13, color: theme.color.ink }}>
        Offline — showing the last synced state{when ? ` · updated ${when}` : ''}.
      </Text>
    </View>
  );
}

function needsInitialSyncRecovery(state: ShadowUiState, counts: { projects: number; jobs: number; approvals: number; questions: number; schedules: number }): boolean {
  return !state.connection.online
    && state.connection.lastSeq == null
    && counts.projects === 0
    && counts.jobs === 0
    && counts.approvals === 0
    && counts.questions === 0
    && counts.schedules === 0;
}

function InitialSyncRecovery({ controller }: { controller: ShadowUiController }) {
  const { theme } = useTheme();
  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 28 }}>
      <View style={{ borderRadius: 18, borderWidth: 0.5, borderColor: theme.color.separator, backgroundColor: theme.color.bgElevated, padding: 18, gap: 12 }}>
        <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: theme.color.orange + '18', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="smartphone" size={24} color={theme.color.orange} />
        </View>
        <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '700', color: theme.color.ink }}>
          Secure sync is still offline
        </Text>
        <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary }}>
          This device has not finished its first secure sync yet. Keep Mochlet open on your Mac, then retry from here.
        </Text>
        <Text style={{ fontSize: 14, lineHeight: 20, color: theme.color.inkSecondary }}>
          If you approved this phone and then force-stopped it before setup completed, revoke this device on your Mac and enroll again. The phone will not trust a server-only grant without the signed local proof.
        </Text>
        <PrimaryButton title="Retry secure sync" icon="refresh" onPress={() => { void controller.refresh(); }} />
        <GhostButton title="Reconnect this device" onPress={() => { void controller.retryEnrollment(); }} />
      </View>
    </ScrollView>
  );
}

// ── section bodies ────────────────────────────────────────────────────────────

function SectionBody({ route, setRoute, controller, state, bottomInset }: { route: Route; setRoute: (r: Route) => void; controller: ShadowUiController; state: ShadowUiState; bottomInset: number }) {
  const { theme } = useTheme();
  const proj = controller.projection();
  const counts = {
    projects: proj.projects().length,
    jobs: proj.projects().flatMap((p) => proj.projectJobs(p.id)).length,
    approvals: proj.pendingApprovals().length,
    questions: proj.pendingQuestions().length,
    schedules: proj.schedules().length,
  };
  const pad = { paddingBottom: bottomInset + 24, paddingTop: 8 };

  if (route.section !== 'controller' && needsInitialSyncRecovery(state, counts)) {
    return <InitialSyncRecovery controller={controller} />;
  }

  // Drilldown: session detail
  if (route.sessionId) {
    const session = proj.session(route.sessionId);
    return <SessionDetail session={session} jobs={proj.projectJobs(session?.projectId ?? '').filter((j) => j.sessionId === route.sessionId)} onBack={() => setRoute({ section: 'projects', projectId: session?.projectId })} bottomInset={bottomInset} />;
  }
  // Drilldown: project detail
  if (route.projectId) {
    const project = proj.projects().find((p) => p.id === route.projectId);
    return <ProjectDetail project={project} sessions={proj.projectSessions(route.projectId)} jobs={proj.projectJobs(route.projectId)} onBack={() => setRoute({ section: 'projects' })} onSession={(id) => setRoute({ section: 'projects', projectId: route.projectId, sessionId: id })} bottomInset={bottomInset} />;
  }

  switch (route.section) {
    case 'overview':
      return <Overview controller={controller} state={state} onPick={setRoute} bottomInset={bottomInset} />;
    case 'projects': {
      const projects = proj.projects();
      if (projects.length === 0) return <EmptyState icon="folder" title="No projects yet" body="Projects on your Mac appear here." />;
      return (
        <FlatList
          data={projects}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ ...pad, paddingHorizontal: 12 }}
          renderItem={({ item }) => <ProjectRow project={item} count={proj.projectSessions(item.id).length} onPress={() => setRoute({ section: 'projects', projectId: item.id })} />}
          initialNumToRender={14}
          windowSize={11}
          removeClippedSubviews
        />
      );
    }
    case 'jobs': {
      const jobs = proj.projects().flatMap((p) => proj.projectJobs(p.id)).sort((a, b) => (b.lastActivity ?? b.createdAt ?? 0) - (a.lastActivity ?? a.createdAt ?? 0));
      if (jobs.length === 0) return <EmptyState icon="jobs" title="No jobs" body="Jobs running on your Mac show up here." />;
      return <FlatList data={jobs} keyExtractor={(j) => j.id} contentContainerStyle={{ ...pad, paddingHorizontal: 12 }} renderItem={({ item }) => <JobRow job={item} />} initialNumToRender={14} windowSize={11} removeClippedSubviews />;
    }
    case 'approvals': {
      const approvals = proj.pendingApprovals();
      if (approvals.length === 0) return <EmptyState icon="shield" title="No pending approvals" body="You’re all caught up." />;
      return <FlatList data={approvals} keyExtractor={(a) => a.id} contentContainerStyle={{ ...pad, paddingHorizontal: 12 }} renderItem={({ item }) => <ApprovalRow approval={item} />} initialNumToRender={14} windowSize={11} removeClippedSubviews />;
    }
    case 'questions': {
      const questions = proj.pendingQuestions();
      if (questions.length === 0) return <EmptyState icon="chat" title="No open questions" />;
      return <FlatList data={questions} keyExtractor={(q) => q.id} contentContainerStyle={{ ...pad, paddingHorizontal: 12 }} renderItem={({ item }) => <QuestionRow question={item} />} initialNumToRender={14} windowSize={11} removeClippedSubviews />;
    }
    case 'schedules': {
      const schedules = proj.schedules();
      if (schedules.length === 0) return <EmptyState icon="calendar" title="No schedules" />;
      return <FlatList data={schedules} keyExtractor={(s) => s.id} contentContainerStyle={{ ...pad, paddingHorizontal: 12 }} renderItem={({ item }) => <ScheduleRow schedule={item} />} initialNumToRender={14} windowSize={11} removeClippedSubviews />;
    }
    case 'screen': {
      const screenGranted = state.enrollment.grantedCapabilityLabels.includes(capabilityLabel('screen.view'));
      return <ScreenSection screenViewGranted={screenGranted} online={state.connection.online} hostName="your Mac" />;
    }
    case 'controller':
      return <ControllerAuthority state={state} controller={controller} bottomInset={bottomInset} />;
    default:
      return <View style={{ flex: 1, backgroundColor: theme.color.bg }} />;
  }
}

function Overview({ controller, state, onPick, bottomInset }: { controller: ShadowUiController; state: ShadowUiState; onPick: (r: Route) => void; bottomInset: number }) {
  const { theme } = useTheme();
  const env = useActionEnv();
  const proj = controller.projection();
  const projects = proj.projects();
  const jobs = projects.flatMap((p) => proj.projectJobs(p.id));
  const running = jobs.filter((j) => j.status === 'running').length;
  const tiles: Array<{ key: SectionKey; label: string; value: number }> = [
    { key: 'projects', label: 'Projects', value: projects.length },
    { key: 'jobs', label: 'Jobs', value: jobs.length },
    { key: 'approvals', label: 'Approvals', value: proj.pendingApprovals().length },
    { key: 'questions', label: 'Questions', value: proj.pendingQuestions().length },
  ];
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: bottomInset + 24 }}>
      <Text accessibilityRole="header" style={{ fontSize: 28, fontWeight: '700', letterSpacing: -0.5, color: theme.color.ink, marginBottom: 4 }}>Overview</Text>
      <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginBottom: 16 }}>
        {state.connection.online ? 'Live from your Mac.' : 'Last synced state from your Mac.'}
        {running > 0 ? ` ${running} running.` : ''}
      </Text>
      {/* Exactly ONE read-only / offline note for the whole controller — shown only when this
          device's verified grant has zero action families (read-only) or it is offline. Never a
          dead button; per-section controls stay capability-gated for subset grants. */}
      <ActionsNote online={env.online} anyGranted={grantedActionFamilies(env.granted).length > 0} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {tiles.map((t) => (
          <Pressable key={t.key} onPress={() => onPick({ section: t.key })} accessibilityRole="button" accessibilityLabel={`${t.label}, ${t.value}`}
            style={{ flexGrow: 1, flexBasis: '44%', backgroundColor: theme.color.bgElevated, borderRadius: 16, borderWidth: 0.5, borderColor: theme.color.separator, padding: 16 }}>
            <Text style={{ fontSize: 30, fontWeight: '700', color: theme.color.ink }}>{t.value}</Text>
            <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginTop: 2 }}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

// ── rows ──────────────────────────────────────────────────────────────────────

function ProjectRow({ project, count, onPress }: { project: ProjectView; count: number; onPress: () => void }) {
  const { theme } = useTheme();
  const tint = idTint(project.id, theme);
  return (
    <TapRow onPress={onPress} label={`${project.name ?? 'Project'}, ${count} session${count === 1 ? '' : 's'}`}>
      <View style={{ width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: tint + '24' }}>
        <Text style={{ fontSize: 18, fontWeight: '800', color: tint }}>{(project.name ?? '?')[0]?.toUpperCase() ?? '?'}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{project.name ?? 'Untitled project'}</Text>
        <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 2 }}>
          {count} session{count === 1 ? '' : 's'}{project.repoHost ? ` · ${project.repoHost}` : ''}
        </Text>
      </View>
      <Icon name="chevronRight" size={18} color={theme.color.inkTertiary} />
    </TapRow>
  );
}

function JobRow({ job }: { job: JobView }) {
  const { theme } = useTheme();
  const env = useActionEnv();
  const when = fmtTime(job.lastActivity ?? job.createdAt);
  return (
    <View>
      <TapRow label={job.title ?? 'Job'}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{job.title ?? 'Job'}</Text>
          <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 2 }}>
            {[job.phase, job.engine, when].filter(Boolean).join(' · ') || '—'}
          </Text>
        </View>
        {job.status ? <StatusChip tone={statusTone(job.status)} label={job.status} /> : null}
      </TapRow>
      {jobCancellable(job) ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8, alignItems: 'flex-start' }}>
          <CancelJobControl job={job} granted={env.granted} online={env.online} />
        </View>
      ) : null}
    </View>
  );
}

function ApprovalRow({ approval }: { approval: ApprovalView }) {
  const { theme } = useTheme();
  const env = useActionEnv();
  return (
    <View>
      <TapRow label={approval.title ?? 'Approval'}>
        <View style={{ width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.orange + '20' }}>
          <Icon name="shield" size={17} color={theme.color.orange} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{approval.title ?? 'Approval requested'}</Text>
          {approval.summary ? <Text numberOfLines={1} style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 2 }}>{approval.summary}</Text> : null}
        </View>
        <StatusChip tone="pending" label="Pending" />
      </TapRow>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <ApprovalControl approval={approval} granted={env.granted} online={env.online} />
      </View>
    </View>
  );
}

function QuestionRow({ question }: { question: QuestionView }) {
  const { theme } = useTheme();
  const env = useActionEnv();
  return (
    <View style={{ paddingBottom: 6 }}>
      <TapRow label={question.question ?? 'Question'}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={2} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{question.question ?? 'Question'}</Text>
        </View>
      </TapRow>
      <View style={{ paddingHorizontal: 16 }}>
        <AnswerQuestionControl question={question} granted={env.granted} online={env.online} />
      </View>
    </View>
  );
}

function ScheduleRow({ schedule }: { schedule: ScheduleView }) {
  const { theme } = useTheme();
  const when = fmtTime(schedule.nextRun);
  return (
    <TapRow label={schedule.title ?? 'Schedule'}>
      <View style={{ width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.indigo + '20' }}>
        <Icon name="calendar" size={17} color={theme.color.indigo} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{schedule.title ?? 'Schedule'}</Text>
        <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 2 }}>{[schedule.cadence, when && `next ${when}`].filter(Boolean).join(' · ') || '—'}</Text>
      </View>
    </TapRow>
  );
}

// ── detail screens ──────────────────────────────────────────────────────────

function BackHeader({ title, onBack }: { title: string; onBack: () => void }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 6 }}>
      <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="arrowLeft" size={22} color={theme.color.blue} />
      </Pressable>
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 18, fontWeight: '700', color: theme.color.ink }}>{title}</Text>
    </View>
  );
}

function ProjectDetail({ project, sessions, jobs, onBack, onSession, bottomInset }: { project: ProjectView | undefined; sessions: SessionView[]; jobs: JobView[]; onBack: () => void; onSession: (id: string) => void; bottomInset: number }) {
  const { theme } = useTheme();
  const env = useActionEnv();
  if (!project) { onBack(); return <View style={{ flex: 1 }} />; }
  return (
    <View style={{ flex: 1 }}>
      <BackHeader title={project.name ?? 'Project'} onBack={onBack} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: bottomInset + 24 }}>
        {project.repoHost ? <Text style={{ fontSize: 13, color: theme.color.inkTertiary, paddingHorizontal: 4, paddingBottom: 10 }}>{project.repoHost}</Text> : null}
        <View style={{ paddingHorizontal: 4, paddingBottom: 14 }}>
          <StartJobControl project={project} granted={env.granted} online={env.online} />
        </View>
        <SectionLabel title={`Sessions (${sessions.length})`} />
        {sessions.length === 0 ? <MutedRow text="No sessions." /> : sessions.map((s, i) => (
          <TapRow key={s.id} last={i === sessions.length - 1} onPress={() => onSession(s.id)} label={s.title ?? 'Session'}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{s.title ?? s.codename ?? 'Session'}</Text>
              <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 2 }}>{[s.engine, s.model, s.branch].filter(Boolean).join(' · ') || '—'}</Text>
            </View>
            <Icon name="chevronRight" size={18} color={theme.color.inkTertiary} />
          </TapRow>
        ))}
        <View style={{ height: 18 }} />
        <SectionLabel title={`Jobs (${jobs.length})`} />
        {jobs.length === 0 ? <MutedRow text="No jobs." /> : jobs.map((j, i) => <View key={j.id}><JobRow job={j} />{i < jobs.length - 1 ? null : null}</View>)}
      </ScrollView>
    </View>
  );
}

function SessionDetail({ session, jobs, onBack, bottomInset }: { session: SessionView | undefined; jobs: JobView[]; onBack: () => void; bottomInset: number }) {
  const { theme } = useTheme();
  const env = useActionEnv();
  if (!session) { onBack(); return <View style={{ flex: 1 }} />; }
  const rows: Array<[string, string | undefined]> = [
    ['Engine', session.engine], ['Model', session.model], ['Branch', session.branch],
    ['Reviewer', session.reviewerEnabled ? (session.reviewer ?? 'On') : undefined],
    ['Autopilot', session.autopilot === undefined ? undefined : session.autopilot ? 'On' : 'Off'],
  ];
  return (
    <View style={{ flex: 1 }}>
      <BackHeader title={session.title ?? session.codename ?? 'Session'} onBack={onBack} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: bottomInset + 24 }} keyboardShouldPersistTaps="handled">
        <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 14 }}>
          {rows.filter(([, v]) => v !== undefined).map(([k, v], i, arr) => (
            <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', minHeight: 44, alignItems: 'center', borderBottomWidth: i === arr.length - 1 ? 0 : 0.5, borderBottomColor: theme.color.separator }}>
              <Text style={{ fontSize: 14, color: theme.color.inkTertiary }}>{k}</Text>
              <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.ink }}>{v}</Text>
            </View>
          ))}
        </View>
        <SessionActionControls session={session} granted={env.granted} online={env.online} />
        <View style={{ height: 18 }} />
        <SectionLabel title={`Jobs (${jobs.length})`} />
        {jobs.length === 0 ? <MutedRow text="No jobs in this session." /> : jobs.map((j) => <JobRow key={j.id} job={j} />)}
      </ScrollView>
    </View>
  );
}

function ControllerAuthority({ state, controller, bottomInset }: { state: ShadowUiState; controller: ShadowUiController; bottomInset: number }) {
  const { theme } = useTheme();
  const e = state.enrollment;
  const rows: Array<[string, string | undefined]> = [
    ['Status', state.connection.online ? 'Connected' : 'Offline'],
    ['This device', e.controllerDeviceIdShort ?? undefined],
    ['Mac fingerprint', e.hostFingerprintShort ?? undefined],
  ];
  // Granted permissions come ONLY from the verified current grant (never a requested list).
  const perms = e.grantedCapabilityLabels.length ? e.grantedCapabilityLabels : e.requestedCapabilityLabels;
  const screenViewGranted = e.grantedCapabilityLabels.includes(capabilityLabel('screen.view'));
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: bottomInset + 24 }}>
      <Text accessibilityRole="header" style={{ fontSize: 24, fontWeight: '700', color: theme.color.ink, marginBottom: 4 }}>Controller</Text>
      <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginBottom: 16 }}>Manage which devices are enrolled from Settings → Controllers on the Mac.</Text>
      <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 14, marginBottom: 16 }}>
        {rows.filter(([, v]) => v !== undefined).map(([k, v]) => (
          <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 46, gap: 12, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator }}>
            <Text style={{ fontSize: 14, color: theme.color.inkTertiary }}>{k}</Text>
            <Text numberOfLines={1} style={{ flex: 1, textAlign: 'right', fontSize: 14, fontWeight: '600', color: theme.color.ink, fontFamily: k.includes('device') || k.includes('fingerprint') ? theme.fontFamily.mono : undefined }}>{v}</Text>
          </View>
        ))}
      </View>

      {/* Granted permissions — exactly what the verified grant permits. */}
      <SectionLabel title="Granted permissions" />
      <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 14, marginBottom: 16 }}>
        {perms.map((label, i) => (
          <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, borderBottomWidth: i === perms.length - 1 ? 0 : 0.5, borderBottomColor: theme.color.separator }}>
            <Icon name="check" size={15} color={theme.color.green} stroke={2.4} />
            <Text style={{ flex: 1, fontSize: 14, color: theme.color.ink }}>{label}</Text>
          </View>
        ))}
      </View>

      {/* Screen access — granted/denied for the separate screen.view capability. */}
      <SectionLabel title="Screen access" />
      <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 14, marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46 }}>
          <Icon name={screenViewGranted ? 'check' : 'lock'} size={15} color={screenViewGranted ? theme.color.green : theme.color.inkTertiary} stroke={2.4} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 14, color: theme.color.ink }}>View Mac screen</Text>
            <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 1 }}>View only · no control or audio</Text>
          </View>
          <StatusChip tone={screenViewGranted ? 'online' : 'neutral'} label={screenViewGranted ? 'Granted' : 'Not granted'} />
        </View>
      </View>
      <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginBottom: 16 }}>
        {screenViewGranted ? 'Open the Screen tab to view your Mac. macOS also shows a screen-recording indicator while viewing.' : 'Re-connect and check “View Mac screen” to enable live screen viewing.'}
      </Text>

      {/* Request additional access — re-enroll via a fresh host-signed QR + approval. */}
      <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginBottom: 10 }}>
        Need this device to do more? Re-connect and choose the extra actions — you’ll scan a fresh code on your Mac and approve it there.
      </Text>
      <GhostButton title="Request additional access" onPress={() => { void controller.retryEnrollment(); }} />
      <View style={{ height: 22 }} />
      <GhostButton title="Sign out" tone="danger" onPress={() => void signOutFromController()} />
    </ScrollView>
  );
}

/**
 * Sign out of the secure controller via the race-free orchestration (R1): capture the
 * active account id, schedule the shadow lock + purge, `await signOut()` (which clears the
 * token synchronously so the root leaves the controller tree straight to splash/auth —
 * NEVER the legacy tabs, even under a rejected/hung sign-out), then clear the captured
 * account's marker last. See `controllerRoot.signOutSecureController`.
 */
function signOutFromController(): Promise<void> {
  return signOutSecureController({
    resetController: resetProductionShadowController,
    signOut,
    captureAccountId: activeControllerAccountId,
    deactivateForAccount: deactivateControllerModeForAccount,
  });
}

function SectionLabel({ title }: { title: string }) {
  const { theme } = useTheme();
  return <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, paddingHorizontal: 4, paddingBottom: 8 }}>{title}</Text>;
}
function MutedRow({ text }: { text: string }) {
  const { theme } = useTheme();
  return <Text style={{ fontSize: 14, color: theme.color.inkTertiary, paddingHorizontal: 4, paddingVertical: 8 }}>{text}</Text>;
}
