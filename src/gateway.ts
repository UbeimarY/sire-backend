/**
 * Edge gateway: the only public entry point.
 *
 * Browsers cannot speak native gRPC (no control over HTTP/2 frames/trailers),
 * so the gateway accepts gRPC-Web over HTTP/1.1 or HTTP/2 and forwards each call
 * to the internal microservices using native gRPC over HTTP/2.
 * This is the same role Envoy plays in the classic gRPC-Web setup.
 */
import http from "node:http";
import { toJsonString, type DescService } from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  cors,
  createClient,
  createContextKey,
  type HandlerContext,
  type Interceptor,
  type ServiceImpl,
} from "@connectrpc/connect";
import { connectNodeAdapter, createGrpcTransport } from "@connectrpc/connect-node";
import { AuthService, Role, type User } from "./gen/sire/v1/auth_pb.js";
import { BenchmarkService, GetTelemetryResponseSchema } from "./gen/sire/v1/benchmark_pb.js";
import { FleetService } from "./gen/sire/v1/fleet_pb.js";
import { HospitalService } from "./gen/sire/v1/hospital_pb.js";
import { IncidentService } from "./gen/sire/v1/incident_pb.js";
import { authClient } from "./lib/clients.js";
import { allowedOrigins, ports, urls } from "./lib/config.js";
import { log } from "./lib/log.js";
import { loggingInterceptor } from "./lib/server.js";
import { buildTelemetry } from "./lib/telemetry.js";

const auth = authClient();
const userKey = createContextKey<User | undefined>(undefined);

// ---- Authentication: validate the bearer token against AuthService (gRPC call) ----
const publicMethods = new Set(["/sire.v1.AuthService/Login", "/sire.v1.BenchmarkService/GetTelemetry"]);

const authInterceptor: Interceptor = (next) => async (req) => {
  if (publicMethods.has(req.url.slice(req.url.indexOf("/sire.v1.")))) return next(req);
  const token = req.header.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { valid, user } = await auth.validateToken({ token });
  if (!valid || !user) throw new ConnectError("Sesión inválida o expirada", Code.Unauthenticated);
  req.contextValues.set(userKey, user);
  return next(req);
};

// ---- Authorization rules per exposed method ----
type Rule = {
  roles: Role[];
  check?: (user: User, request: Record<string, unknown>) => void;
};
const anyone: Rule = { roles: [Role.OPERATOR, Role.HOSPITAL, Role.ADMIN] };
const operators: Rule = { roles: [Role.OPERATOR, Role.ADMIN] };
const ownHospital: Rule = {
  roles: [Role.HOSPITAL, Role.ADMIN],
  check: (user, request) => {
    if (user.role === Role.HOSPITAL && request.hospitalId !== user.hospitalId) {
      throw new ConnectError("Solo puede gestionar su propio hospital", Code.PermissionDenied);
    }
  },
};

function authorize(rule: Rule, ctx: HandlerContext, request: Record<string, unknown>) {
  const user = ctx.values.get(userKey);
  if (!user) throw new ConnectError("No autenticado", Code.Unauthenticated);
  if (!rule.roles.includes(user.role)) throw new ConnectError("Rol sin permisos", Code.PermissionDenied);
  rule.check?.(user, request);
}

/**
 * Builds a service implementation that forwards allow-listed methods to the
 * internal microservice. Only unary and server-streaming methods are exposed,
 * which are exactly the call types gRPC-Web supports in browsers.
 */
function forward<S extends DescService>(service: S, baseUrl: string, rules: Record<string, Rule | "public">) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createClient(service, createGrpcTransport({ baseUrl })) as any;
  const impl: Record<string, unknown> = {};
  for (const method of service.methods) {
    const rule = rules[method.localName];
    if (!rule) continue;
    const guard = (req: Record<string, unknown>, ctx: HandlerContext) => {
      if (rule !== "public") authorize(rule, ctx, req);
    };
    if (method.methodKind === "unary") {
      impl[method.localName] = async (req: Record<string, unknown>, ctx: HandlerContext) => {
        guard(req, ctx);
        return client[method.localName](req, { signal: ctx.signal });
      };
    } else if (method.methodKind === "server_streaming") {
      impl[method.localName] = async function* (req: Record<string, unknown>, ctx: HandlerContext) {
        guard(req, ctx);
        yield* client[method.localName](req, { signal: ctx.signal });
      };
    }
  }
  return impl as Partial<ServiceImpl<S>>;
}

const grpcHandler = connectNodeAdapter({
  grpcWeb: true, // browsers
  grpc: true, // native clients (when the platform supports HTTP/2 end to end)
  connect: true,
  interceptors: [loggingInterceptor("gateway"), authInterceptor],
  routes(router) {
    router.service(AuthService, forward(AuthService, urls.auth, { login: "public" }));
    router.service(
      IncidentService,
      forward(IncidentService, urls.incident, {
        createIncident: operators,
        getIncident: anyone,
        listIncidents: anyone,
        watchIncidents: anyone,
        getMetrics: anyone,
      }),
    );
    router.service(FleetService, forward(FleetService, urls.fleet, { listAmbulances: anyone, watchFleet: anyone }));
    router.service(
      HospitalService,
      forward(HospitalService, urls.hospital, {
        listHospitals: anyone,
        watchHospitals: anyone,
        updateBeds: ownHospital,
        watchIncomingPatients: ownHospital,
      }),
    );
    // Served by the gateway itself, so the benchmark measures only serialization + transport.
    router.service(BenchmarkService, {
      getTelemetry: (req) => buildTelemetry(req.count),
    });
  },
});

// ---- CORS (frontend is deployed on a different origin) ----
function applyCors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", cors.allowedMethods.join(", "));
    res.setHeader("Access-Control-Allow-Headers", [...cors.allowedHeaders, "Authorization"].join(", "));
    res.setHeader("Access-Control-Expose-Headers", [...cors.exposedHeaders, "X-Payload-Bytes"].join(", "));
    res.setHeader("Access-Control-Max-Age", "7200");
  }
}

const server = http.createServer((req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "SIRE gateway", status: "ok", protocol: "gRPC-Web" }));
    return;
  }
  // REST/JSON twin of BenchmarkService.GetTelemetry, for the REST vs gRPC comparison.
  if (url.pathname === "/api/rest/telemetry" && req.method === "GET") {
    const body = toJsonString(GetTelemetryResponseSchema, buildTelemetry(Number(url.searchParams.get("count"))));
    res.writeHead(200, { "Content-Type": "application/json", "X-Payload-Bytes": Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  grpcHandler(req, res);
});

server.listen(ports.gateway, "0.0.0.0", () => log("gateway", `gRPC-Web gateway listening on :${ports.gateway}`));
