import "./globals.css";

export const metadata = {
  title: "HomeStream — your media, on every screen",
  description: "Ampchor-style local media server for your PC. Stream your video library to this PC or any device on your Wi-Fi.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
  appleWebApp: {
    capable: true,
    title: "HomeStream",
    statusBarStyle: "black-translucent",
  },
};

export const viewport = {
  themeColor: "#10141b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
