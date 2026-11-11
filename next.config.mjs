/** @type {import('next').NextConfig} */
const nextConfig = {
  // Everything is local/LAN; nothing needs external image loading.
  images: { unoptimized: true },
  // Tailscale addresses hit the dev server too (100.x = VPN, torres-1 = MagicDNS).
  allowedDevOrigins: ["100.91.192.12", "torres-1"],
  // The BitTorrent engine and SQLite stay real Node modules at runtime.
  serverExternalPackages: ["webtorrent", "better-sqlite3"],
};

export default nextConfig;
