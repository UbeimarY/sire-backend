import http2 from "node:http2";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { log } from "./log.js";

/** Logs every RPC with its duration. */
export const loggingInterceptor =
  (serviceName: string): Interceptor =>
  (next) =>
  async (req) => {
    const started = Date.now();
    try {
      const res = await next(req);
      if (!req.stream) log(serviceName, `${req.method.name} ok ${Date.now() - started}ms`);
      return res;
    } catch (err) {
      log(serviceName, `${req.method.name} failed: ${(err as Error).message}`);
      throw err;
    }
  };

/**
 * Starts an internal microservice as a native gRPC server over HTTP/2 (h2c).
 */
export function startGrpcServer(name: string, port: number, routes: (router: ConnectRouter) => void) {
  const handler = connectNodeAdapter({
    routes,
    grpc: true,
    grpcWeb: false,
    connect: false,
    interceptors: [loggingInterceptor(name)],
  });
  const server = http2.createServer(handler);
  server.listen(port, "0.0.0.0", () => log(name, `gRPC server listening on :${port} (HTTP/2)`));
  return server;
}
