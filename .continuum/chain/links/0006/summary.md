We do not need global skills and tools remove that from settings.
→ ## Done — fix on `fix/drop-global-skills-from-settings`

**Diff** (`apps/desktop/src/screens/Settings.tsx`, +4 / −3):
- Removed the `{ key: 'skills', icon: 'spark', label: 'Skills & tools', tint: 'var(--indigo)' }` entry from `SET_NAV`.
- Dropped the now-dead `n.key === 'skills' ? navigate('/skills-