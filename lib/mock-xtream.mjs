// Mock Xtream Codes provider for testing the login flow without real credentials.
import http from "node:http";

const M3U = `#EXTM3U
#EXTINF:-1 tvg-logo="http://127.0.0.1:9090/logo1.png" group-title="News",Demo News 24
http://127.0.0.1:9090/live/demo/demo/101.m3u8
#EXTINF:-1 tvg-logo="http://127.0.0.1:9090/logo2.png" group-title="Movies",Demo Cinema HD
http://127.0.0.1:9090/live/demo/demo/102.m3u8`;

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/player_api.php") {
    const ok = u.searchParams.get("username") === "demo" && u.searchParams.get("password") === "demo";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ok
      ? { user_info: { status: "Active", auth: 1, username: "demo" } }
      : { user_info: { status: "Invalid credentials", auth: 0 } }));
    return;
  }
  if (u.pathname === "/get.php") {
    if (u.searchParams.get("username") === "demo" && u.searchParams.get("password") === "demo") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(M3U);
      return;
    }
    res.writeHead(403); res.end(); return;
  }
  res.writeHead(404); res.end();
}).listen(9090, "127.0.0.1", () => console.log("mock xtream provider on http://127.0.0.1:9090"));
