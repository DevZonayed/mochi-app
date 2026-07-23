/**
 * ControllerProjects — Projects tab, redesigned as a POS-style drill-down:
 *
 *   1. Type landing  — three big category buttons: Code, Design, Agent (everything else),
 *                      each with a live project count, plus a "Recent" shortcut list.
 *   2. Project list  — the chosen type's projects, searchable, lazy-loaded with infinite
 *                      scroll (windowed pagination; "Loading more…" footer).
 *   3. Project detail— sessions for one project with an Active / Archived segmented control;
 *                      active sessions show first, archived live behind the segment. The list
 *                      lazy-loads with infinite scroll. "Start a job" begins a new session.
 *   4. Session       — the in-session chat window with all controls (SessionChatView).
 *
 * Data is the gated in-memory projection; pagination is windowed (render N, grow on
 * onEndReached) to keep FlatList light on large accounts without a network round-trip.
 */
import React from 'react';
import { View, Text, FlatList, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useTheme } from '../../theme';
import { Icon, type IconName } from '../../Icon';
import { useController } from './ControllerContext';
import { useActionEnv, StartJobControl } from './ActionControls';
import type { ProjectView, SessionView, JobView } from '../../shadowProjectionSelectors';
import {
  Screen, EmptyState, KindBadge, kindColor, useInsets,
} from './parts';
import { SessionChatView } from './SessionChatView';

// ── project-type buckets → the three POS buttons ────────────────────────────
type Bucket = 'code' | 'design' | 'agent';
function bucketOf(kind: string | undefined): Bucket {
  // Host kind for software projects is 'coding' (see PROJECT_KINDS). Anything with a
  // git repo is also treated as Code so repo-backed projects never fall into Agent.
  if (kind === 'coding') return 'code';
  if (kind === 'design') return 'design';
  return 'agent'; // content / research / general / context / unknown all live under "Agent"
}
/** A project is "Code" if the host tagged it 'coding' OR it is backed by a git repo. */
function bucketOfProject(p: { kind?: string; repoHost?: string; repoPath?: string }): Bucket {
  if ((p.repoHost || p.repoPath) && p.kind !== 'design') return 'code';
  return bucketOf(p.kind);
}
const BUCKETS: Array<{ key: Bucket; label: string; icon: IconName; tone: 'blue' | 'purple' | 'teal' }> = [
  { key: 'code', label: 'Code', icon: 'terminal', tone: 'blue' },
  { key: 'design', label: 'Design', icon: 'palette', tone: 'purple' },
  { key: 'agent', label: 'Agent', icon: 'spark', tone: 'teal' },
];

function fmtRelTime(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const d = Date.now() - ms;
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d`;
  try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; }
}

/** Windowed pagination: render `step`, grow on demand; resets when `resetKey` changes. */
function usePaged<T>(items: T[], step: number, resetKey: string) {
  const [count, setCount] = React.useState(step);
  React.useEffect(() => { setCount(step); }, [resetKey, step]);
  const visible = React.useMemo(() => items.slice(0, count), [items, count]);
  const hasMore = count < items.length;
  const loadMore = React.useCallback(() => setCount((c) => c + step), [step]);
  return { visible, hasMore, loadMore };
}

// ── internal route state (not React Navigation) ─────────────────────────────
interface ProjectsRoute {
  view: 'types' | 'list' | 'project' | 'session';
  bucket?: Bucket;
  projectId?: string;
  sessionId?: string;
}

export function ControllerProjects() {
  const { controller } = useController();
  const [route, setRoute] = React.useState<ProjectsRoute>({ view: 'types' });
  const proj = controller.projection();
  const allProjects = proj.projects();

  // 4. Session chat window
  if (route.view === 'session' && route.sessionId) {
    return (
      <SessionChatView
        sessionId={route.sessionId}
        onBack={() => setRoute({ view: 'project', bucket: route.bucket, projectId: route.projectId })}
      />
    );
  }

  // 3. Project detail (sessions)
  if (route.view === 'project' && route.projectId) {
    const project = allProjects.find((p) => p.id === route.projectId);
    return (
      <Screen>
        <ProjectDetail
          project={project}
          sessions={proj.projectSessions(route.projectId)}
          jobs={proj.projectJobs(route.projectId)}
          onBack={() => setRoute({ view: 'list', bucket: route.bucket })}
          onSession={(id) => setRoute({ view: 'session', bucket: route.bucket, projectId: route.projectId, sessionId: id })}
        />
      </Screen>
    );
  }

  // 2. Project list for a chosen type
  if (route.view === 'list' && route.bucket) {
    return (
      <Screen>
        <ProjectList
          bucket={route.bucket}
          projects={allProjects.filter((p) => bucketOfProject(p) === route.bucket)}
          sessionsCount={(id) => proj.projectSessions(id).length}
          projectJobs={(id) => proj.projectJobs(id)}
          onBack={() => setRoute({ view: 'types' })}
          onProject={(id) => setRoute({ view: 'project', bucket: route.bucket, projectId: id })}
        />
      </Screen>
    );
  }

  // 1. Type landing
  return (
    <Screen>
      <TypeLanding
        projects={allProjects}
        onBucket={(b) => setRoute({ view: 'list', bucket: b })}
        onProject={(id) => { const p = allProjects.find((x) => x.id === id); setRoute({ view: 'project', bucket: p ? bucketOfProject(p) : 'agent', projectId: id }); }}
      />
    </Screen>
  );
}

// ── 1. type landing (POS buttons) ───────────────────────────────────────────
function TypeLanding({ projects, onBucket, onProject }: {
  projects: ProjectView[]; onBucket: (b: Bucket) => void; onProject: (id: string) => void;
}) {
  const { theme } = useTheme();
  const insets = useInsets();
  const counts: Record<Bucket, number> = { code: 0, design: 0, agent: 0 };
  for (const p of projects) counts[bucketOfProject(p)] += 1;
  const recent = projects.slice(0, 5); // projection is pre-sorted by recency

  const toneColor = (t: 'blue' | 'purple' | 'teal') => (t === 'blue' ? theme.color.blue : t === 'purple' ? theme.color.purple : theme.color.teal);

  return (
    <FlatList
      data={recent}
      keyExtractor={(p) => p.id}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      ListHeaderComponent={
        <View style={{ paddingTop: insets.top + 12, paddingHorizontal: 16 }}>
          <Text style={{ fontSize: 32, fontWeight: '700', letterSpacing: -0.6, color: theme.color.ink }}>Projects</Text>
          <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginTop: 3, marginBottom: 18 }}>
            {projects.length} across 3 types
          </Text>

          {BUCKETS.map((b) => {
            const c = toneColor(b.tone);
            return (
              <Pressable
                key={b.key}
                onPress={() => onBucket(b.key)}
                accessibilityRole="button"
                accessibilityLabel={`${b.label}, ${counts[b.key]} projects`}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 16,
                  backgroundColor: theme.color.bgElevated, borderRadius: 20, borderWidth: 0.5, borderColor: c + '55',
                  paddingHorizontal: 16, paddingVertical: 18, marginBottom: 14,
                  transform: [{ scale: pressed ? 0.985 : 1 }],
                })}
              >
                <View style={{ width: 60, height: 60, borderRadius: 18, backgroundColor: c, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={b.icon} size={28} color="#fff" />
                </View>
                <Text style={{ flex: 1, fontSize: 24, fontWeight: '700', letterSpacing: -0.4, color: theme.color.ink }}>{b.label}</Text>
                <View style={{ paddingHorizontal: 12, height: 30, borderRadius: 15, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.inkSecondary }}>
                    {counts[b.key]} project{counts[b.key] !== 1 ? 's' : ''}
                  </Text>
                </View>
              </Pressable>
            );
          })}

          {recent.length > 0 ? (
            <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginTop: 8, marginBottom: 4 }}>
              Recent
            </Text>
          ) : null}
        </View>
      }
      ListEmptyComponent={<EmptyState icon="folder" title="No projects" body="Projects on your Mac appear here." />}
      renderItem={({ item }) => (
        <View style={{ paddingHorizontal: 16 }}>
          <ProjectRow project={item} sessions={0} running={0} onPress={() => onProject(item.id)} compact />
        </View>
      )}
      initialNumToRender={8}
      windowSize={9}
      removeClippedSubviews
    />
  );
}

// ── 2. project list for a type (infinite scroll) ────────────────────────────
function ProjectList({ bucket, projects, sessionsCount, projectJobs, onBack, onProject }: {
  bucket: Bucket; projects: ProjectView[];
  sessionsCount: (id: string) => number; projectJobs: (id: string) => JobView[];
  onBack: () => void; onProject: (id: string) => void;
}) {
  const { theme } = useTheme();
  const insets = useInsets();
  const [search, setSearch] = React.useState('');
  const meta = BUCKETS.find((b) => b.key === bucket)!;

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name?.toLowerCase().includes(q));
  }, [projects, search]);

  const { visible, hasMore, loadMore } = usePaged(filtered, 12, `${bucket}:${search}`);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 8, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="arrowLeft" size={22} color={theme.color.blue} />
        </Pressable>
        <Text style={{ flex: 1, fontSize: 22, fontWeight: '700', letterSpacing: -0.4, color: theme.color.ink }}>{meta.label}</Text>
        <Text style={{ fontSize: 15, fontWeight: '600', color: theme.color.inkTertiary, marginRight: 12 }}>{filtered.length}</Text>
      </View>

      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: theme.color.fillSecondary, borderRadius: 12, paddingHorizontal: 12, height: 40 }}>
          <Icon name="search" size={16} color={theme.color.inkTertiary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={`Search ${meta.label} projects`}
            placeholderTextColor={theme.color.inkTertiary}
            style={{ flex: 1, fontSize: 15, color: theme.color.ink, paddingVertical: 0 }}
          />
          {search.length > 0 ? (
            <Pressable onPress={() => setSearch('')} hitSlop={8} accessibilityLabel="Clear search">
              <Icon name="xCircle" size={16} color={theme.color.inkTertiary} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {filtered.length === 0 ? (
        <EmptyState icon="folder" title={search ? 'No matches' : `No ${meta.label} projects`} body={search ? 'Try a different search.' : 'Projects of this type appear here.'} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
          renderItem={({ item }) => {
            const jobs = projectJobs(item.id);
            return (
              <ProjectRow
                project={item}
                sessions={sessionsCount(item.id)}
                running={jobs.filter((j) => j.status === 'running').length}
                onPress={() => onProject(item.id)}
              />
            );
          }}
          onEndReached={hasMore ? loadMore : undefined}
          onEndReachedThreshold={0.5}
          ListFooterComponent={hasMore ? <LoadingMore /> : null}
          initialNumToRender={12}
          windowSize={11}
          removeClippedSubviews
        />
      )}
    </View>
  );
}

// ── shared project row ──────────────────────────────────────────────────────
function ProjectRow({ project, sessions, running, onPress, compact }: {
  project: ProjectView; sessions: number; running: number; onPress: () => void; compact?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${project.name ?? 'Untitled'}${sessions ? `, ${sessions} sessions` : ''}`}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 13,
        borderBottomWidth: 0.5, borderBottomColor: theme.color.separator, opacity: pressed ? 0.6 : 1,
      })}
    >
      <KindBadge kind={project.kind} size={compact ? 40 : 44} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{project.name ?? 'Untitled'}</Text>
        <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 2 }}>
          {compact
            ? (project.repoHost ?? fmtRelTime(project.lastActivity) ?? '')
            : `${sessions} session${sessions !== 1 ? 's' : ''}${project.repoHost ? ` · ${project.repoHost}` : ''}`}
        </Text>
      </View>
      {running > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, height: 22, borderRadius: 11, backgroundColor: theme.color.green + '20' }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.color.green }} />
          <Text style={{ fontSize: 11, fontWeight: '700', color: theme.color.ink }}>{running}</Text>
        </View>
      ) : null}
      <Icon name="chevronRight" size={18} color={theme.color.inkTertiary} />
    </Pressable>
  );
}

// ── 3. project detail (sessions with Active / Archived) ─────────────────────
function ProjectDetail({ project, sessions, jobs, onBack, onSession }: {
  project: ProjectView | undefined; sessions: SessionView[]; jobs: JobView[];
  onBack: () => void; onSession: (id: string) => void;
}) {
  const { theme } = useTheme();
  const env = useActionEnv();
  const insets = useInsets();
  const [tab, setTab] = React.useState<'active' | 'archived'>('active');

  if (!project) { onBack(); return <View style={{ flex: 1 }} />; }

  const runningSessionIds = React.useMemo(
    () => new Set(jobs.filter((j) => j.status === 'running' && j.sessionId).map((j) => j.sessionId!)),
    [jobs],
  );
  const active = React.useMemo(() => sessions.filter((s) => !s.archived), [sessions]);
  const archived = React.useMemo(() => sessions.filter((s) => s.archived), [sessions]);
  const shown = tab === 'active' ? active : archived;
  const { visible, hasMore, loadMore } = usePaged(shown, 12, `${project.id}:${tab}`);
  const kc = kindColor(project.kind, theme);

  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 8, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="arrowLeft" size={22} color={theme.color.blue} />
        </Pressable>
        <KindBadge kind={project.kind} size={32} />
        <View style={{ flex: 1, minWidth: 0, marginLeft: 6 }}>
          <Text numberOfLines={1} style={{ fontSize: 18, fontWeight: '700', color: theme.color.ink }}>{project.name ?? 'Project'}</Text>
          {project.repoHost ? (
            <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkTertiary }}>{project.repoHost}{project.repoPath ? ` · ${project.repoPath}` : ''}</Text>
          ) : null}
        </View>
      </View>

      <FlatList
        data={visible}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
        ListHeaderComponent={
          <View style={{ paddingTop: 6 }}>
            {/* Active / Archived segmented control */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.color.fillSecondary, borderRadius: 12, padding: 3 }}>
                {(['active', 'archived'] as const).map((t) => {
                  const on = tab === t;
                  const count = t === 'active' ? active.length : archived.length;
                  return (
                    <Pressable
                      key={t}
                      onPress={() => setTab(t)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      style={{ flex: 1, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? theme.color.bgElevated : 'transparent', flexDirection: 'row', gap: 6 }}
                    >
                      <Text style={{ fontSize: 14, fontWeight: '600', color: on ? theme.color.ink : theme.color.inkTertiary }}>
                        {t === 'active' ? 'Active' : 'Archived'}
                      </Text>
                      <Text style={{ fontSize: 12, fontWeight: '600', color: theme.color.inkTertiary }}>{count}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Start a new session (job) */}
            <View style={{ marginBottom: 18 }}>
              <StartJobControl project={project} granted={env.granted} online={env.online} />
            </View>

            <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 4 }}>
              {tab === 'active' ? 'Active sessions' : 'Archived sessions'}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <SessionRow session={item} kindColorHex={kc} running={runningSessionIds.has(item.id)} onPress={() => onSession(item.id)} />
        )}
        ListEmptyComponent={
          <Text style={{ fontSize: 14, color: theme.color.inkTertiary, paddingVertical: 14 }}>
            {tab === 'active' ? 'No active sessions. Start a job to begin one.' : 'No archived sessions.'}
          </Text>
        }
        onEndReached={hasMore ? loadMore : undefined}
        onEndReachedThreshold={0.5}
        ListFooterComponent={hasMore ? <LoadingMore /> : null}
        initialNumToRender={12}
        windowSize={11}
        removeClippedSubviews
      />
    </View>
  );
}

// ── session row ─────────────────────────────────────────────────────────────
function SessionRow({ session, kindColorHex, running, onPress }: {
  session: SessionView; kindColorHex: string; running: boolean; onPress: () => void;
}) {
  const { theme } = useTheme();
  const subtitle = [session.engine, session.model, session.branch].filter(Boolean).join(' · ') || '—';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${session.title ?? session.codename ?? 'Session'}${running ? ', running' : ''}`}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12,
        borderBottomWidth: 0.5, borderBottomColor: theme.color.separator, opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: kindColorHex + '18', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="messageCircle" size={19} color={kindColorHex} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{session.title ?? session.codename ?? 'Session'}</Text>
        <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2 }}>{subtitle}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {running ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.green }} /> : null}
        <Text style={{ fontSize: 12, color: theme.color.inkTertiary }}>{fmtRelTime(session.lastActivity ?? session.createdAt)}</Text>
      </View>
    </Pressable>
  );
}

// ── infinite-scroll footer ──────────────────────────────────────────────────
function LoadingMore() {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 18 }}>
      <ActivityIndicator size="small" color={theme.color.inkTertiary} />
      <Text style={{ fontSize: 13, color: theme.color.inkTertiary }}>Loading more…</Text>
    </View>
  );
}
