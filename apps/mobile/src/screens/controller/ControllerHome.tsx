/**
 * ControllerHome — Dashboard tab for the controller bottom bar. Shows a greeting,
 * connection status, quick stats, needs-attention items (approvals + questions), and
 * running jobs. Matches the design mockup: large time-based greeting, live indicator,
 * 2x2 stat tiles, running-now section with progress, and quick-action buttons.
 */
import React from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useTheme } from '../../theme';
import { Icon, MaestroMark } from '../../Icon';
import { useController } from './ControllerContext';
import { grantedActionFamilies } from '../../shadowActionCapabilities';
import { ActionsNote, useActionEnv } from './ActionControls';
import { Screen, StatusChip, ConnBadge, useInsets } from './parts';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function fmtRelative(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = Math.max(0, Date.now() - ms);
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}


export function ControllerHome() {
  const { theme } = useTheme();
  const { state, controller } = useController();
  const env = useActionEnv();
  const insets = useInsets();
  const proj = controller.projection();
  const projects = proj.projects();
  const allJobs = React.useMemo(() => projects.flatMap((p) => proj.projectJobs(p.id)), [projects, proj]);
  const runningJobs = allJobs.filter((j) => j.status === 'running');
  const approvals = proj.pendingApprovals();
  const questions = proj.pendingQuestions();

  const tiles: Array<{ label: string; value: number; color: string; icon: React.ReactElement }> = [
    { label: 'Projects', value: projects.length, color: theme.color.blue, icon: <Icon name="folder" size={16} color={theme.color.blue} /> },
    { label: 'Jobs', value: allJobs.length, color: theme.color.purple, icon: <Icon name="jobs" size={16} color={theme.color.purple} /> },
    { label: 'Approvals', value: approvals.length, color: theme.color.green, icon: <Icon name="shield" size={16} color={theme.color.green} /> },
    { label: 'Questions', value: questions.length, color: theme.color.orange, icon: <Icon name="chat" size={16} color={theme.color.orange} /> },
  ];

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: insets.bottom + 24 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <MaestroMark size={36} />
          <ConnBadge online={state.connection.online} />
        </View>

        {/* Greeting */}
        <Text style={{ fontSize: 32, fontWeight: '700', letterSpacing: -0.6, color: theme.color.ink, marginTop: 8, marginBottom: 4 }}>
          {greeting()}
        </Text>
        <Text style={{ fontSize: 14, color: theme.color.inkSecondary, marginBottom: 20 }}>
          {state.connection.online ? 'Connected to your Mac.' : 'Showing last synced data.'}
          {runningJobs.length > 0 ? ` ${runningJobs.length} running.` : ''}
        </Text>

        {/* Read-only / offline note */}
        <ActionsNote online={env.online} anyGranted={grantedActionFamilies(env.granted).length > 0} />

        {/* Connection card */}
        <Pressable style={{ backgroundColor: theme.color.bgElevated, borderRadius: 16, borderWidth: 0.5, borderColor: theme.color.separator, padding: 16, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: (state.connection.online ? theme.color.green : theme.color.orange) + '18', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={state.connection.online ? 'wifi' : 'wifiOff'} size={22} color={state.connection.online ? theme.color.green : theme.color.orange} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>{state.connection.online ? 'Live' : 'Offline'}</Text>
            <Text style={{ fontSize: 13, color: theme.color.inkSecondary, marginTop: 2 }}>
              {state.connection.online ? 'Connected to your Mac' : 'Mac is unreachable'}
            </Text>
          </View>
          <Icon name="chevronRight" size={18} color={theme.color.inkTertiary} />
        </Pressable>

        {/* Stat tiles */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
          {tiles.map((t) => (
            <View key={t.label} style={{ flexGrow: 1, flexBasis: '46%', backgroundColor: theme.color.bgElevated, borderRadius: 16, borderWidth: 0.5, borderColor: theme.color.separator, padding: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                {t.icon}
              </View>
              <Text style={{ fontSize: 30, fontWeight: '700', color: t.color, letterSpacing: -0.5 }}>{t.value}</Text>
              <Text style={{ fontSize: 13, color: theme.color.inkSecondary, marginTop: 2 }}>{t.label}</Text>
            </View>
          ))}
        </View>

        {/* Running now */}
        {runningJobs.length > 0 ? (
          <View style={{ marginBottom: 20 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 10 }}>
              Running now
            </Text>
            {runningJobs.slice(0, 5).map((job) => {
              const progress = job.progress ?? 0;
              return (
                <View key={job.id} style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, padding: 14, marginBottom: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.color.green }} />
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{job.title ?? 'Job'}</Text>
                      <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2 }}>
                        {[job.engine, job.phase, fmtRelative(job.createdAt)].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    {progress > 0 ? (
                      <Text style={{ fontSize: 13, fontWeight: '700', color: theme.color.blue }}>{Math.round(progress * 100)}%</Text>
                    ) : null}
                  </View>
                  {progress > 0 ? (
                    <View style={{ height: 4, borderRadius: 2, backgroundColor: theme.color.fillSecondary, marginTop: 10 }}>
                      <View style={{ width: `${Math.min(100, Math.round(progress * 100))}%`, height: 4, borderRadius: 2, backgroundColor: theme.color.blue }} />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        {/* Needs attention */}
        {approvals.length > 0 || questions.length > 0 ? (
          <View style={{ marginBottom: 20 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 10 }}>
              Needs your attention
            </Text>
            {approvals.slice(0, 3).map((a) => (
              <View key={a.id} style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, padding: 14, marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: theme.color.orange + '20', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="shield" size={17} color={theme.color.orange} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{a.title ?? 'Approval requested'}</Text>
                    {a.summary ? <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2 }}>{a.summary}</Text> : null}
                  </View>
                  <StatusChip tone="pending" label="Pending" />
                </View>
              </View>
            ))}
            {questions.slice(0, 3).map((q) => (
              <View key={q.id} style={{ backgroundColor: theme.color.bgElevated, borderRadius: 14, borderWidth: 0.5, borderColor: theme.color.separator, padding: 14, marginBottom: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: theme.color.purple + '20', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="chat" size={17} color={theme.color.purple} />
                  </View>
                  <Text numberOfLines={2} style={{ flex: 1, fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{q.question ?? 'Question'}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* Recent projects */}
        {projects.length > 0 ? (
          <View>
            <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkSecondary, marginBottom: 10 }}>
              Recent projects
            </Text>
            {projects.slice(0, 6).map((p) => {
              const sessions = proj.projectSessions(p.id).length;
              const jobs = proj.projectJobs(p.id).length;
              return (
                <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator }}>
                  <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: theme.color.fillSecondary, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 17, fontWeight: '800', color: theme.color.ink }}>{(p.name ?? '?')[0]?.toUpperCase()}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: theme.color.ink }}>{p.name ?? 'Project'}</Text>
                    <Text style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 1 }}>
                      {sessions} session{sessions !== 1 ? 's' : ''} · {jobs} job{jobs !== 1 ? 's' : ''}
                    </Text>
                  </View>
                  <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} />
                </View>
              );
            })}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
