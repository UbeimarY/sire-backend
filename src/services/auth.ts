import { createHmac, timingSafeEqual } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { AuthService, Role, UserSchema, type User } from "../gen/sire/v1/auth_pb.js";
import { jwtSecret, ports } from "../lib/config.js";
import { startGrpcServer } from "../lib/server.js";

interface StoredUser {
  user: User;
  password: string;
}

const demoPassword = process.env.DEMO_PASSWORD ?? "sire2026";

const users: StoredUser[] = [
  { username: "operador", displayName: "Laura Gómez (Operadora 123)", role: Role.OPERATOR },
  { username: "admin", displayName: "Administrador SIRE", role: Role.ADMIN },
  { username: "hospital.central", displayName: "Urgencias – Hospital Central", role: Role.HOSPITAL, hospitalId: "h1" },
  { username: "hospital.norte", displayName: "Urgencias – Clínica del Norte", role: Role.HOSPITAL, hospitalId: "h2" },
  { username: "hospital.sur", displayName: "Urgencias – Hospital del Sur", role: Role.HOSPITAL, hospitalId: "h3" },
  { username: "hospital.occidente", displayName: "Urgencias – Clínica Occidente", role: Role.HOSPITAL, hospitalId: "h4" },
].map((u, i) => ({ user: create(UserSchema, { id: `u${i + 1}`, ...u }), password: demoPassword }));

// Token = base64url(payload).base64url(HMAC-SHA256(payload)). Small JWT-like token.
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", jwtSecret).update(payload).digest("base64url");
}

function issueToken(user: User): string {
  const payload = Buffer.from(JSON.stringify({ sub: user.id, exp: Date.now() + TOKEN_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string): User | undefined {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return undefined;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub: string; exp: number };
  if (Date.now() > exp) return undefined;
  return users.find((u) => u.user.id === sub)?.user;
}

startGrpcServer("auth", ports.auth, (router) =>
  router.service(AuthService, {
    login(req) {
      const found = users.find((u) => u.user.username === req.username.trim().toLowerCase());
      if (!found || found.password !== req.password) {
        throw new ConnectError("Usuario o contraseña incorrectos", Code.Unauthenticated);
      }
      return { token: issueToken(found.user), user: found.user };
    },
    validateToken(req) {
      const user = verifyToken(req.token);
      return user ? { valid: true, user } : { valid: false };
    },
  }),
);
