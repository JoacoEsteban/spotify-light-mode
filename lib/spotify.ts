/**
 * Shared by the content script's declared `matches` and the background script's
 * tab query, so the set of pages the extension claims can never drift between
 * the two.
 */
export const SPOTIFY_MATCHES = ["https://open.spotify.com/*"] as const;
