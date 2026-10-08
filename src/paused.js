import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 10000);

const server = createServer((req, res) => {
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({
    ok: false,
    status: "paused",
    message: "DZ TO DC bridge is temporarily paused."
  }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("DZ TO DC bridge is PAUSED. No Discord/DZ bridge is running.");
});