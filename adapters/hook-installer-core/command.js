export function buildHookCommand(cliPath, mode) {
  return `node "${cliPath}" hook ${mode}`;
}
