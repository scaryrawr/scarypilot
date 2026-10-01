let input = "";

for await (const chunk of process.stdin) input += chunk;

const request = JSON.parse(input);

if (request.org === "https://dev.azure.com/diagnostic-fixture") {
  process.stderr.write(`${JSON.stringify({
    type: "ado_request_diagnostic", source: "http", method: "GET", status: 200,
    attempt: 1, waitMs: 0, durationMs: 12, retryAfterSeconds: null,
  })}\n`);
  process.stderr.write(`${JSON.stringify({
    type: "ado_request_diagnostic", source: "cache", cacheHit: true,
  })}\n`);
  process.stderr.write(`${JSON.stringify({
    type: "ado_request_diagnostic", source: "cache", cacheHit: true,
    url: "https://private.example/secret", body: "private authored text",
  })}\n`);
}

if (request.org === "https://dev.azure.com/failing-fixture") {
  process.stderr.write('{"type":"ado_request_diagnostic","source":"cache","cacheHit":true}\n');
  process.stderr.write('{"error":"organization cooldown; defer 120s","deferred":true,"retryAt":1234}\n');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ request }));
}
