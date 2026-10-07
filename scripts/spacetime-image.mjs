// Change the default only after the GHCR manifest is published and validated.
// state-volume-init intentionally continues using the original official image.
export const DEFAULT_SPACETIME_IMAGE =
  "clockworklabs/spacetime@sha256:acf3210403559f731e222fb77042aac32429d7ea77a4858ffa68bd459383069d";

export function getSpacetimeImage(env = process.env) {
  const image = env.NOX_BOT_SPACETIMEDB_IMAGE ?? DEFAULT_SPACETIME_IMAGE;
  if (!image.trim() || /\s/.test(image))
    throw new Error("NOX_BOT_SPACETIMEDB_IMAGE must be a nonblank Docker image reference without whitespace.");
  return image;
}
