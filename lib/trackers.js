/**
 * Shared public tracker list (Stremio-style fallback injection).
 * Kept in its own zero-dependency module: importing consts across
 * lib/qbittorrent.js ↔ lib/rqbit.js created a bundler-order dependency
 * that manifested as a TDZ ReferenceError in the compiled bundle.
 */
export const FALLBACK_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.tiny-vps.com:6969/announce",
  "udp://tracker.cyberia.is:6969/announce",
  "udp://tracker.moeking.me:6969/announce",
  "udp://opentracker.io:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
];
