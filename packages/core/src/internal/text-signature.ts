/** A Google signature belongs to its original text part, including an empty part. */
export function hasGoogleTextSignature(part: {
  providerMetadata?: Record<string, unknown>;
}): boolean {
  const google = part.providerMetadata?.google;
  return (
    google !== null &&
    typeof google === 'object' &&
    typeof (google as Record<string, unknown>).thoughtSignature === 'string'
  );
}

/** Only unsigned text may be coalesced; signed parts are opaque replay boundaries. */
export function canMergeTextParts(
  left: { providerMetadata?: Record<string, unknown> },
  right: { providerMetadata?: Record<string, unknown> },
): boolean {
  return !hasGoogleTextSignature(left) && !hasGoogleTextSignature(right);
}
