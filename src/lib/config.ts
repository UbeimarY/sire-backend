// Internal service ports (HTTP/2 cleartext, native gRPC).
// Each microservice runs as its own process and talks to the others over gRPC.
const host = process.env.INTERNAL_HOST ?? "127.0.0.1";

export const ports = {
  auth: Number(process.env.AUTH_PORT ?? 50051),
  fleet: Number(process.env.FLEET_PORT ?? 50052),
  hospital: Number(process.env.HOSPITAL_PORT ?? 50053),
  dispatch: Number(process.env.DISPATCH_PORT ?? 50054),
  incident: Number(process.env.INCIDENT_PORT ?? 50055),
  // Public edge port: gRPC-Web for browsers (Render/Railway inject PORT).
  gateway: Number(process.env.PORT ?? 8080),
};

export const urls = {
  auth: process.env.AUTH_URL ?? `http://${host}:${ports.auth}`,
  fleet: process.env.FLEET_URL ?? `http://${host}:${ports.fleet}`,
  hospital: process.env.HOSPITAL_URL ?? `http://${host}:${ports.hospital}`,
  dispatch: process.env.DISPATCH_URL ?? `http://${host}:${ports.dispatch}`,
  incident: process.env.INCIDENT_URL ?? `http://${host}:${ports.incident}`,
};

export const jwtSecret = process.env.JWT_SECRET ?? "sire-dev-secret-change-me";

// Comma separated list of allowed browser origins, "*" allows all.
export const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
