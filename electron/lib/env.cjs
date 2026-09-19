// The environment handed to processes we spawn: the release build and the
// packaged backend. An allowlist, never the whole parent environment, so a
// developer's provider keys cannot leak into a child by any name.
//
// Windows children need the OS variables that initialise Winsock / Chromium
// networking, cmd.exe (npm is a .cmd shim), and per-user directories; without
// SystemRoot/windir the bundled server fails to bind with `listen UNKNOWN`.
const hostEnvironmentKeys = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL',
  ...(process.platform === 'win32' ? [
    'SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME',
    'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  ] : []),
];
function pickHostEnvironment(extra = [], source = process.env) {
  return Object.fromEntries([...hostEnvironmentKeys, ...extra].filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
module.exports = { hostEnvironmentKeys, pickHostEnvironment };
