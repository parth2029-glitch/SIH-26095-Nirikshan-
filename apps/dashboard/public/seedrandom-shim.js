/**
 * `assign()` imports the bare specifier `seedrandom`; browsers cannot resolve
 * one. verify.html loads the UMD build as a classic script — which sets
 * `Math.seedrandom` — and maps the specifier here through an import map.
 *
 * Classic scripts run during parsing, module scripts after it, so the global is
 * always set by the time this evaluates. §13 deletes this file: a bundler
 * resolves the specifier itself.
 */
export default Math.seedrandom;
