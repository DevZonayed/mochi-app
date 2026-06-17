import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, ActivityIndicator, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Icon } from '../Icon';
import { api, ApiError, type DirListing, type ProjectKind } from '../api';

const KINDS: { key: ProjectKind; label: string }[] = [
  { key: 'coding', label: 'Code' },
  { key: 'design', label: 'Design' },
  { key: 'content', label: 'Content' },
  { key: 'research', label: 'Research' },
  { key: 'general', label: 'General' },
];

const PALETTE = ['blue', 'purple', 'indigo', 'teal', 'orange', 'green', 'red'];
const colorFromName = (n: string): string => PALETTE[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

/** Last path segment for a compact display. */
const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p;

export function CreateProjectScreen() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProjectKind>('coding');
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [mode, setMode] = useState<'form' | 'browse'>('form');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loadingDir, setLoadingDir] = useState(false);

  const loadDir = useCallback((path?: string) => {
    setLoadingDir(true);
    api.browseDir(path)
      .then(setListing)
      .catch((e: unknown) => {
        const msg = e instanceof ApiError
          ? e.status === 404
            ? 'Your Mac is running an older Maestro that doesn’t support folder browsing yet. Update the desktop app + relay.'
            : e.status === 503
              ? 'Your Mac isn’t connected to the relay right now.'
              : e.message
          : 'Could not reach your Mac.';
        Alert.alert('Could not open folder', msg);
      })
      .finally(() => setLoadingDir(false));
  }, []);

  const openBrowser = () => { setMode('browse'); loadDir(pickedPath ?? undefined); };
  const useThisFolder = () => { if (listing) { setPickedPath(listing.path); setMode('form'); } };

  const create = () => {
    const nm = name.trim();
    if (!nm || creating) return;
    setCreating(true);
    api.createProject({ name: nm, kind, color: colorFromName(nm), ...(pickedPath ? { path: pickedPath } : {}) })
      .then(() => nav.goBack())
      .catch((e: unknown) => { setCreating(false); Alert.alert('Could not create project', e instanceof Error ? e.message : 'Try again — your Mac may be offline.'); });
  };

  // ── Folder browser ──────────────────────────────────────────────────────
  if (mode === 'browse') {
    return (
      <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
        <View style={{ paddingTop: insets.top + 4, paddingBottom: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator }}>
          <Pressable onPress={() => setMode('form')} hitSlop={8}><Icon name="arrowLeft" size={22} color={theme.color.blue} /></Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: theme.color.ink }}>Choose a folder</Text>
            <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 1, fontFamily: theme.fontFamily.mono }}>{listing?.path ?? '…'}</Text>
          </View>
          <Pressable onPress={() => loadDir(listing?.home)} hitSlop={8} style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="home" size={20} color={theme.color.inkSecondary} />
          </Pressable>
        </View>

        {loadingDir && !listing ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={theme.color.blue} /></View>
        ) : (
          <ScrollView contentContainerStyle={{ paddingVertical: 8, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
            {listing?.parent ? (
              <Pressable onPress={() => loadDir(listing.parent!)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 18, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator }}>
                <Icon name="arrowLeft" size={18} color={theme.color.inkSecondary} />
                <Text style={{ fontSize: 15, fontWeight: '500', color: theme.color.inkSecondary }}>Up to {baseName(listing.parent)}</Text>
              </Pressable>
            ) : null}
            {listing?.error ? (
              <Text style={{ fontSize: 14, color: theme.color.red, padding: 18 }}>{listing.error}</Text>
            ) : null}
            {listing?.entries.map((e) => (
              <Pressable
                key={e.path}
                disabled={!e.isDir}
                onPress={() => e.isDir && loadDir(e.path)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 18, opacity: e.isDir ? 1 : 0.5 }}
              >
                <Icon name={e.isDir ? 'folder' : 'file'} size={19} color={e.isDir ? theme.color.blue : theme.color.inkTertiary} />
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, fontWeight: e.isDir ? '600' : '400', color: theme.color.ink }}>{e.name}</Text>
                {e.isRepo ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 20, borderRadius: 10, backgroundColor: theme.color.green + '24' }}>
                    <Icon name="gitMerge" size={11} color={theme.color.green} />
                    <Text style={{ fontSize: 11, fontWeight: '600', color: theme.color.green }}>repo</Text>
                  </View>
                ) : null}
                {e.isDir ? <Icon name="chevronRight" size={16} color={theme.color.inkTertiary} /> : null}
              </Pressable>
            ))}
            {listing && listing.entries.length === 0 && !listing.error ? (
              <Text style={{ fontSize: 14, color: theme.color.inkTertiary, padding: 18, textAlign: 'center' }}>This folder is empty.</Text>
            ) : null}
          </ScrollView>
        )}

        {/* use-this-folder bar */}
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: 16, paddingTop: 12, paddingBottom: insets.bottom + 12, borderTopWidth: 0.5, borderTopColor: theme.color.separator, backgroundColor: theme.color.bgGrouped }}>
          <Pressable onPress={useThisFolder} disabled={!listing} style={{ height: 52, borderRadius: theme.radius.pill, backgroundColor: theme.color.blue, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }}>
            <Icon name="check" size={17} color="#fff" stroke={2.6} />
            <Text style={{ fontSize: 16, fontWeight: '600', color: '#fff' }} numberOfLines={1}>Use {listing ? baseName(listing.path) : 'this folder'}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Form ────────────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <View style={{ paddingTop: insets.top + 4, paddingBottom: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 0.5, borderBottomColor: theme.color.separator }}>
        <Pressable onPress={() => nav.goBack()} hitSlop={8}><Icon name="arrowLeft" size={22} color={theme.color.blue} /></Pressable>
        <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: theme.color.ink }}>New project</Text>
        <Pressable onPress={create} disabled={!name.trim() || creating} hitSlop={8}>
          {creating ? <ActivityIndicator size="small" color={theme.color.blue} /> : <Text style={{ fontSize: 16, fontWeight: '700', color: name.trim() ? theme.color.blue : theme.color.inkTertiary }}>Create</Text>}
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 24 }} showsVerticalScrollIndicator={false}>
        {/* name */}
        <View style={{ gap: 9 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkTertiary }}>Project name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            autoFocus
            placeholder="e.g. drop-shipping"
            placeholderTextColor={theme.color.inkTertiary}
            style={{ height: 52, borderRadius: 14, backgroundColor: theme.color.bgElevated, borderWidth: 1, borderColor: theme.color.separator, paddingHorizontal: 16, fontSize: 17, color: theme.color.ink }}
          />
        </View>

        {/* type */}
        <View style={{ gap: 9 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkTertiary }}>Type</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {KINDS.map((k) => {
              const on = kind === k.key;
              return (
                <Pressable key={k.key} onPress={() => setKind(k.key)} style={{ height: 36, paddingHorizontal: 15, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? theme.color.blue : theme.color.fillSecondary }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: on ? '#fff' : theme.color.inkSecondary }}>{k.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* location */}
        <View style={{ gap: 9 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: theme.color.inkTertiary }}>Folder</Text>
          <Pressable onPress={openBrowser} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, borderRadius: 14, backgroundColor: theme.color.bgElevated, borderWidth: 1, borderColor: theme.color.separator }}>
            <View style={{ width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.blue + '20' }}>
              <Icon name="folder" size={20} color={theme.color.blue} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: pickedPath ? theme.color.ink : theme.color.inkSecondary }}>{pickedPath ? baseName(pickedPath) : 'Pick a folder on your Mac'}</Text>
              <Text numberOfLines={1} style={{ fontSize: 12, color: theme.color.inkTertiary, marginTop: 2, fontFamily: theme.fontFamily.mono }}>{pickedPath ?? 'Optional — leave empty for a chat-only project'}</Text>
            </View>
            <Icon name="chevronRight" size={18} color={theme.color.inkTertiary} />
          </Pressable>
          {pickedPath ? (
            <Pressable onPress={() => setPickedPath(null)} hitSlop={6} style={{ alignSelf: 'flex-start' }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: theme.color.red }}>Clear folder</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
