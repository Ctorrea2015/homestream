/** @type {import('next').NextConfig} */
const nextConfig = {
  // Everything is local/LAN; nothing needs external image loading.
  images: { unoptimized: true },
  // The BitTorrent engine stays a real Node module at runtime.
  serverExternalPackages: ["webtorrent"],
};

export default nextConfig;
