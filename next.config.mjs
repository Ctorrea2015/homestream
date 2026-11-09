/** @type {import('next').NextConfig} */
const nextConfig = {
  // Everything is local/LAN; nothing needs external image loading.
  images: { unoptimized: true },
  // The BitTorrent engine and SQLite stay real Node modules at runtime.
  serverExternalPackages: ["webtorrent", "better-sqlite3"],
};

export default nextConfig;
