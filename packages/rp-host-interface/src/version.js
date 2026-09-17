/**
 * The Harness lineage this Roleplay suite is built and verified against.
 *
 * This is the one place in the suite that names a DeepSeek Harness version.
 * Every package manifest pins the same version, and `pnpm run check:compat`
 * fails the build when any of them drifts, so changing the baseline means
 * changing this constant and re-running `node tools/adapt-harness.mjs`.
 */

/** The DeepSeek Harness release the Roleplay suite targets. */
export const DS_ROLEPLAY_HARNESS = '0.1.5-rc.1'

/**
 * Harness pre-release ranges do not compose the way `^` suggests: a caret range
 * over a pre-release (`^0.1.5-rc.1`) resolves forward to the newest matching
 * pre-release rather than staying on the pinned one. A mixed graph leaves peer
 * dependencies unsatisfied, because `^0.1.5-rc.1` does not accept `0.1.5-rc.1`.
 *
 * The suite therefore pins every Harness package to one exact version and
 * verifies the resolved lockfile, instead of relying on range operators.
 */
export const HARNESS_VERSIONS_ARE_EXACT = true
