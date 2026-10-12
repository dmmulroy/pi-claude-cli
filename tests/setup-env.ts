/**
 * Drop this extension's own knobs before any test runs.
 *
 * Every `PI_CLAUDE_CLI_*` variable changes what the provider does, and the
 * most likely place to run these tests is a pi session that is ITSELF driven
 * by this extension, whose shell may export them. Tests that need a knob set
 * it themselves (and restore it), so clearing the environment here can only
 * remove ambient state.
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_CLAUDE_CLI_")) delete process.env[key];
}
