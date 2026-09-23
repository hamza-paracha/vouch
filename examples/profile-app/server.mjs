import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const dataFile = resolve(process.env.DATA_FILE ?? "out/profile-example.json");
await mkdir(dirname(dataFile), { recursive: true });
await writeFile(dataFile, '{"displayName":"Original"}\n', { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Profile preferences</title></head>
<body><h1>Profile preferences</h1><form id="profile"><label>Display name <input name="displayName" value="Original"></label>
<button>Save profile</button></form><p role="status" id="status">Ready</p>
<script>
document.querySelector('form').onsubmit = async (event) => {
  event.preventDefault();
  const response = await fetch('/api/profile', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({displayName:document.querySelector('input').value})});
  document.querySelector('#status').textContent = response.ok ? 'Profile saved' : 'Save failed';
};
</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/") { res.writeHead(302, { location: "/settings" }); res.end(); return; }
    if (req.url === "/settings") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (req.url === "/api/profile" && req.method === "GET") {
      res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
      res.end(await readFile(dataFile, "utf8")); return;
    }
    if (req.url === "/api/profile" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 16000) { res.writeHead(413); res.end(); return; } }
      const profile = JSON.parse(body);
      if (typeof profile.displayName !== "string" || profile.displayName.length > 100) { res.writeHead(400); res.end(); return; }
      // Report success only after the new profile has been persisted.
      await writeFile(dataFile, JSON.stringify({ displayName: profile.displayName }) + "\n");
      res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); return;
    }
    res.writeHead(404); res.end("Not found");
  } catch { res.writeHead(500); res.end("Request failed"); }
});
server.listen(Number(process.env.PORT ?? 4178), "127.0.0.1", () => {
  const address = server.address();
  console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}` }));
});
