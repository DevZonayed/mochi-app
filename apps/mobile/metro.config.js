// Expo + pnpm monorepo Metro config: watch the workspace root so the
// @maestro/* workspace packages resolve, and let Metro follow symlinks.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;
config.resolver.unstable_enableSymlinks = true;

// react-native-webrtc deep-imports `event-target-shim/index`, a subpath that
// event-target-shim v6's `exports` map no longer exposes (so Metro's package-
// exports resolution rejects it). Redirect that one specifier to the package
// root, whose `.` export points at index.js. (Paired with a pnpm override that
// dedupes event-target-shim to v6 so the root copy actually has index.js.)
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolveRequest ?? context.resolveRequest;
  if (moduleName === 'event-target-shim/index') {
    return resolve(context, 'event-target-shim', platform);
  }
  // The shared @maestro/realtime crypto/enrollment modules are TypeScript source
  // that uses NodeNext-style explicit `.js` relative specifiers (they resolve
  // under Node/tsc). Metro doesn't remap `.js` → `.ts`, so when a relative `.js`
  // specifier has no real `.js` file, retry against the extensionless name (Metro
  // then finds the `.ts` source). Real `.js` files still resolve as-is first.
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, moduleName, platform);
    } catch (err) {
      try {
        return resolve(context, moduleName.slice(0, -3), platform);
      } catch {
        throw err;
      }
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
