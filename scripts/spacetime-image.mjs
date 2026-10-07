// Match the deployment and bot toolchain defaults.
// state-volume-init intentionally continues using the original official image.
export const DEFAULT_SPACETIME_IMAGE =
  "ghcr.io/mapherez/nox-spacetimedb:latest";

export function getSpacetimeImage(env = process.env) {
  const image = env.NOX_BOT_SPACETIMEDB_IMAGE ?? DEFAULT_SPACETIME_IMAGE;
  if (!image.trim() || /\s/.test(image))
    throw new Error("NOX_BOT_SPACETIMEDB_IMAGE must be a nonblank Docker image reference without whitespace.");
  return image;
}
