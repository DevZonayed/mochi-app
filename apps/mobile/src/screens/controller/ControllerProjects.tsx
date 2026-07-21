/**
 * ControllerProjects — Projects tab with type-based grouping and filtering.
 * Shows horizontal filter chips (All, Code, Design, Content, Research, General)
 * and project cards with type-colored icons. Drill-in to project detail with
 * sessions/jobs, then to session detail with action controls.
 */
import React from 'react';
import { View, Text, FlatList, ScrollView, TextInput, Pressable } from 'react-native';
import { useTheme } from '../../theme';
import { Icon } from '../../Icon';
import { useController } from './ControllerContext';
import { useActionEnv, StartJobControl, SessionActionControls, CancelJobControl } from './ActionControls';
import type { ProjectView, SessionView, JobView } from '../../shadowProjectionSelectors';
import {
  Screen, StatusChip, EmptyState, KindBadge, kindColor, useInsets,
  type StatusTone,
} from './parts';
import { jobCancellable } from '../../shadowActionModel';

const KINDS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'code', label: 'Code' },
  { key: 'design', label: 'Design' },
  { key: 'content', label: 'Content' },
  { key: 'research', label: 'Research' },
  { key: 'general', label: 'General' },
];

function statusTone(s: string | undefined): StatusTone {
  if (s === 'running' || s === 'active') return 'online';
  if (s === 'failed' || s === 'error' || s === 'blocked') return 'locked';
  if (s === 'pending' || s === 'queued') return 'pending';
  return 'neutral';
}

function fmtTime(ms: number | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return null; }
}

// ── internal route state (not React Navigation) ───────────────────────────
interface ProjectsRoute {
  view: 'list' | 'project' | 'session';
  projectId?: string;
  sessionId?: string;
}

export function ControllerProjects() {
  const { theme } = useTheme();
  const { controller } = useController();
  const insets = useInsets();
  const [route, setRoute] = React.useState<ProjectsRoute>({ view: 'list' });
  const [filter, setFilter] = React.useState('all');
  const [search, setSearch] = React.useState('');

  const proj = controller.projection();

  // Drill-in: session detail
  if (route.view === 'session' && route.sessionId) {
    const session = proj.session(route.sessionId);
    const jobs = proj.projectJobs(session?.projectId ?? '').filter((j) => j.sessionId === route.sessionId);
    return (
      <Screen>
        <SessionDetail
          session={session}
          jobs={jobs}
          onBack={() => setRoute({ view: 'project', projectId: session?.projectId })}
          bottomInset={insets.bottom}
        />
      </Screen>
    );
  }

  // Drill-in: project detail
  if (route.view === 'project' && route.projectId) {
    const project = proj.projects().find((p) => p.id === route.projectId);
    const sessions = proj.projectSessions(route.projectId);
    const jobs = proj.projectJobs(route.projectId);
    return (
      <Screen>
        <ProjectDetail
          project={project}
          sessions={sessions}
          jobs={jobs}
          onBack={() => setRoute({ view: 'list' })}
          onSession={(id) => setRoute({ view: 'session', projectId: route.projectId, sessionId: id })}
          bottomInset={insets.bottom}
        />
      </Screen>
    );
  }

  // Project list
  const allProjects = proj.projects();
  const filtered = allProjects.filter((p) => {
    if (filter !== 'all' && (p.kind ?? 'general') !== filter) return false;
    if (search.trim() && !p.name?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <Screen>
      <View style={{ paddingTop: insets.top + 12, paddingHorizontal: 16, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <Text style={{ fontSize: 32, fontWeight: '700', letterSpacing: -0.6, color: theme.color.ink }}>Projects</Text>
        </View>
        {/* Search bar */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: theme.color.fillSecondary, borderRadius: 12, paddingHorizontal: 12, height: 40, marginBottom: 12 }}>
          <Icon name="search" size={16} color={theme.color.inkTertiary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search projects"
            placeholderTextColor={theme.color.inkTertiary}
            style={{ flex: 1, fontSize: 15, color: theme.color.ink, paddingVertical: 0 }}
          />
          {search.length > 0 ? (
            <Pressable onPress={() => setSearch('')} hitSlop={8}>
              <Icon name="xCircle" size={16} color={theme.color.inkTertiary} />
            </Pressable>
          ) : null}
        </View>
        {/* Type filter chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 4 }}>
          {KINDS.map((k) => {
            const active = k.key === filter;
            const count = k.key === 'all' ? allProjects.length : allProjects.filter((p) => (p.kind ?? 'general') === k.key).length;
            if (k.key !== 'all' && count === 0) return null;
            return (
              <Pressable key={k.key} onPress={() => setFilter(k.key)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 34, borderRadius: 17, backgroundColor: active ? theme.color.blue : theme.color.fillSecondary }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#fff' : theme.color.ink }}>{k.label}</Text>
                <Text style={{ fontSize: 12, fontWeight: '600', color: active ? 'rgba(255,255,255,0.7)' : theme.color.inkTertiary }}>{count}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {filtered.length === 0 ? (
        <EmptyState icon="folder" title={search ? 'No matches' : 'No projects'} body={search ? 'Try a different search.' : 'Projects on your Mac appear here.'} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}
          renderItem={({ item }) => (
            <ProjectCard
              project={item}
              sessions={proj.projectSessions(item.id).length}
              jobs={proj.projectJobs(item.id)}
              onPress={() => setRoute({ view: 'project', projectId: item.id })}
            />
          )}
          initialNumToRender={14}
          windowSize={11}
          removeClippedSubviews
        />
      )}
    </Screen>
  );
}

// ── project card ──────────────────────────────────────────────────────────
function ProjectCard({ project, sessions, jobs, onPress }: { project: ProjectView; sessions: number; jobs: JobView[]; onPress: () => void }) {
  const { theme } = useTheme();
  const running = jobs.filter((j) => j.status === 'running').length;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${project.name}, ${sessions} sessions`}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 13,
        borderBottomWidth: 0.5, borderBottomColor: theme.color.separator,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <KindBadge kind={project.kind} size={44} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{project.name ?? 'Untitled'}</Text>
        <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginTop: 2 }}>
          {sessions} session{sessions !== 1 ? 's' : ''}
          {project.repoHost ? ` · ${project.repoHost}` : ''}
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

// ── project detail ────────────────────────────────────────────────────────
function ProjectDetail({ project, sessions, jobs, onBack, onSession, bottomInset }: {
  project: ProjectView | undefined; sessions: SessionView[]; jobs: JobView[];
  onBack: () => void; onSession: (id: string) => void; bottomInset: number;
}) {
  const { theme } = useTheme();
  const env = useActionEnv();
  const insets = useInsets();
  if (!project) { onBack(); return <View style={{ flex: 1 }} />; }
  const kc = kindColor(project.kind, theme);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 8, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Pressable onPress={onBack} hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="arrowLeft" size={22} color={theme.color.blue} />
        </Pressable>
        <KindBadge kind={project.kind} size={32} />
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 18, fontWeight: '700', color: theme.color.ink, marginLeft: 6 }}>{project.name ?? 'Project'}</Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomInset + 24 }}>
        {/* Repo info */}
        {project.repoHost ? (
          <Text style={{ fontSize: 13, color: theme.color.inkTertiary, marginBottom: 10 }}>{project.repoHost}{project.repoPath ? ` · ${project.repoPath}` : ''}</Text>
        ) : null}

        {/* Start job */}
        <View style={{ marginBottom: 16 }}>
          <StartJobControl project={project} granted={env.granted} online={env.online} />
        </View>

        {/* Sessions */}
        <SectionLabel title={`Sessions (${sessions.length})`} />
        {sessions.length === 0 ? (
          <Text style={{ fontSize: 14, color: theme.color.inkTertiary, paddingVertical: 8 }}>No sessions.</Text>
        ) : sessions.map((s) => (
          <Pressable key={s.id} onPress={() => onSession(s.id)}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator, opacity: pressed ? 0.6 : 1 })}>
            <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: kc + '18', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="messageCircle" size={17} color={kc} />
            </View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{s.title ?? s.codename ?? 'Session'}</Text>
              <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2 }}>{[s.engine, s.model, s.branch].filter(Boolean).join(' · ') || '---'}</Text>
            </View>
            <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
          </Pressable>
        ))}

        <View style={{ height: 20 }} />

        {/* Jobs */}
        <SectionLabel title={`Jobs (${jobs.length})`} />
        {jobs.length === 0 ? (
          <Text style={{ fontSize: 14, color: theme.color.inkTertiary, paddingVertical: 8 }}>No jobs.</Text>
        ) : jobs.map((j) => (
          <View key={j.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator }}>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{j.title ?? 'Job'}</Text>
                <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2 }}>{[j.phase, j.engine, fmtTime(j.lastActivity ?? j.createdAt)].filter(Boolean).join(' · ')}</Text>
              </View>
              {j.status ? <StatusChip tone={statusTone(j.status)} label={j.status} /> : null}
            </View>
            {jobCancellable(j) ? (
              <View style={{ paddingVertical: 6, alignItems: 'flex-start' }}>
                <CancelJobControl job={j} granted={env.granted} online={env.online} />
              </View>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// ── session detail ────────────────────────────────────────────────────────
function SessionDetail({ session, jobs, onBack, bottomInset }: { session: SessionView | undefined; jobs: JobView[]; onBack: () => void; bottomInset: number }) {
  const { theme } = useTheme();
  const env = useActionEnv();
  const insets = useInsets();
  if (!session) { onBack(); return <View style={{ flex: 1 }} />; }
  const rows: Array<[string, string | undefined]> = [
    ['Engine', session.engine], ['Model', session.model], ['Branch', session.branch],
    ['Reviewer', session.reviewerEnabled ? (session.reviewer ?? 'On') : undefined],
    ['Autopilot', session.autopilot === undefined ? undefined : session.autopilot ? 'On' : 'Off'],
  ];
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingTop: insets.top + 6, paddingHorizontal: 8, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Pressable onPress={onBack} hitSlop={8} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="arrowLeft" size={22} color={theme.color.blue} />
        </Pressable>
        <Text numberOfLines={1} style={{ flex: 1, fontSize: 18, fontWeight: '700', color: theme.color.ink }}>{session.title ?? session.codename ?? 'Session'}</Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomInset + 24 }} keyboardShouldPersistTaps="handled">
        {/* Session info card */}
        <View style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, paddingHorizontal: 14, marginBottom: 12 }}>
          {rows.filter(([, v]) => v !== undefined).map(([k, v], i, arr) => (
            <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', minHeight: 44, alignItems: 'center', borderBottomWidth: i === arr.length - 1 ? 0 : 0.5, borderBottomColor: theme.color.separator }}>
              <Text style={{ fontSize: 14, color: theme.color.inkTertiary }}>{k}</Text>
              <Text style={{ fontSize: 14, fontWeight: '600', color: theme.color.ink }}>{v}</Text>
            </View>
          ))}
        </View>

        {/* Session action controls */}
        <SessionActionControls session={session} granted={env.granted} online={env.online} />

        <View style={{ height: 20 }} />

        {/* Jobs in this session */}
        <SectionLabel title={`Jobs (${jobs.length})`} />
        {jobs.length === 0 ? (
          <Text style={{ fontSize: 14, color: theme.color.inkTertiary, paddingVertical: 8 }}>No jobs in this session.</Text>
        ) : jobs.map((j) => (
          <View key={j.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator }}>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{j.title ?? 'Job'}</Text>
              <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2 }}>{[j.phase, j.engine].filter(Boolean).join(' · ')}</Text>
            </View>
            {j.status ? <StatusChip tone={statusTone(j.status)} label={j.status} /> : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function SectionLabel({ title }: { title: string }) {
  const { theme } = useTheme();
  return <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 8 }}>{title}</Text>;
}
