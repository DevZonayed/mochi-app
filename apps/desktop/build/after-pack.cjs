// electron-builder afterPack hook — ad-hoc code-sign the macOS .app.
//
// We ship without an Apple Developer ID (no $99 cert). On Apple Silicon an
// UNSIGNED app fails Gatekeeper hard ("'Maestro' is damaged and can't be
// opened"). Re-signing the whole bundle with an ad-hoc signature (`codesign
// --sign -`) makes it a VALID — if unidentified — signed app, which downgrades
// that to the softer "Apple could not verify… → Open Anyway / right-click Open"
// prompt. No cert, no keychain, free.
//
// This is a stopgap: a clean double-click (no prompt at all) still requires a
// Developer ID signature + notarization. See electron/updater.ts MAC_SILENT_UPDATE.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename; // "Maestro"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  // --deep re-signs nested frameworks/helpers; --force overwrites Electron's
  // own signatures so the whole bundle is consistently ad-hoc signed.
  execFileSync('codesign', ['--deep', '--force', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`afterPack: ad-hoc signed ${appPath}`);
};
