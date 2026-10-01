#!/usr/bin/env node
// Stands in for anvil in `test/live/anvil.test.ts`: answers every JSON-RPC request on the port
// after `--port` and runs until it is killed.
import { createServer } from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"jsonrpc":"2.0","id":1,"result":"0xaa36a7"}');
  });
}).listen(port, "127.0.0.1");
