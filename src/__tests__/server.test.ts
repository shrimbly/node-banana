// @vitest-environment node
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../server.js", import.meta.url), "utf8");

async function start(env: Record<string, string> = {}, args: string[] = []) {
  const handle = vi.fn();
  const server = { listen: vi.fn(), requestTimeout: 0, headersTimeout: 0 };
  let handler!: (req: { headers: { host: string } }, res: unknown) => Promise<void>;
  const next = vi.fn(() => ({
    prepare: () => Promise.resolve(),
    getRequestHandler: () => handle,
  }));
  runInNewContext(source, {
    process: { env: { ...env }, argv: ["node", "server.js", ...args] },
    URL,
    console: { log: vi.fn() },
    require: (name: string) => name === "next" ? next : {
      createServer: (callback: typeof handler) => { handler = callback; return server; },
    },
  });
  await Promise.resolve();
  return { next, handle, server, handler };
}

describe("local server boundary", () => {
  it.each([{ args: [] }, { args: ["--production"] }])("binds loopback in dev and production ($args)", async ({ args }) => {
    const { server, next } = await start({}, args);
    expect(server.listen).toHaveBeenCalledWith(3000, "127.0.0.1", expect.any(Function));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ dev: args.length === 0 }));
  });

  it.each(["localhost:3000", "127.0.0.1:3000", "[::1]:3000"])("accepts loopback Host %s", async (host) => {
    const { handler, handle } = await start();
    const req = { headers: { host } };
    const res = {};
    await handler(req, res);
    expect(handle).toHaveBeenCalledWith(req, res);
  });

  it("rejects DNS-rebinding hostnames before Next handles the request", async () => {
    const { handler, handle } = await start({}, ["--production"]);
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await handler({ headers: { host: "attacker.example:3000" } }, res);
    expect(res.writeHead).toHaveBeenCalledWith(403);
    expect(handle).not.toHaveBeenCalled();
  });

  it("preserves explicit network hosting and custom ports", async () => {
    const { server, handler, handle } = await start({ HOST: "0.0.0.0", PORT: "8000" }, ["--production"]);
    expect(server.listen).toHaveBeenCalledWith("8000", "0.0.0.0", expect.any(Function));
    await handler({ headers: { host: "banana.example" } }, {});
    expect(handle).toHaveBeenCalledOnce();
  });
});
