/**
 * Ambulance simulator: a native gRPC client (HTTP/2) for each ambulance.
 *  - FleetService.StreamAmbulanceLocation  -> CLIENT STREAMING (GPS every tick)
 *  - DispatchService.AmbulanceSession      -> BIDIRECTIONAL STREAMING (assignments / status)
 */
import { create } from "@bufbuild/protobuf";
import { AmbulanceStatus } from "./gen/sire/v1/common_pb.js";
import { AmbulanceMessageSchema, type AmbulanceMessage, type Assignment } from "./gen/sire/v1/dispatch_pb.js";
import { LocationUpdateSchema, type Ambulance, type LocationUpdate } from "./gen/sire/v1/fleet_pb.js";
import { dispatchClient, fleetClient } from "./lib/clients.js";
import { stepTowards, distanceKm, type LatLng } from "./lib/geo.js";
import { log } from "./lib/log.js";
import { createQueue } from "./lib/queue.js";

const fleet = fleetClient();
const dispatch = dispatchClient();

const TICK_MS = Number(process.env.SIM_TICK_MS ?? 1000);
// Demo time compression: km travelled per tick (0.12 km/s ≈ a short demo trip).
const STEP_KM = Number(process.env.SIM_STEP_KM ?? 0.12);
const SCENE_TICKS = 6;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Phase =
  | { kind: "idle" }
  | { kind: "toIncident"; assignment: Assignment }
  | { kind: "onScene"; assignment: Assignment; ticksLeft: number }
  | { kind: "toHospital"; assignment: Assignment }
  | { kind: "atHospital"; assignment: Assignment; ticksLeft: number };

async function runAmbulance(ambulance: Ambulance) {
  let position: LatLng = { lat: ambulance.location!.lat, lng: ambulance.location!.lng };
  let phase = { kind: "idle" } as Phase;
  let tick = 0;

  const outbound = createQueue<AmbulanceMessage>();
  const gps = createQueue<LocationUpdate>();

  const report = (incidentId: string, status: AmbulanceStatus, etaSeconds: number, note = "") =>
    outbound.push(
      create(AmbulanceMessageSchema, { payload: { case: "status", value: { incidentId, status, etaSeconds, note } } }),
    );
  const etaTo = (target: LatLng) => Math.ceil(distanceKm(position, target) / STEP_KM) * (TICK_MS / 1000);

  // Bidirectional session.
  outbound.push(create(AmbulanceMessageSchema, { payload: { case: "hello", value: { ambulanceId: ambulance.id } } }));
  const session = (async () => {
    for await (const msg of dispatch.ambulanceSession(outbound)) {
      if (msg.payload.case === "welcome") log("simulator", msg.payload.value.message);
      if (msg.payload.case === "assignment" && phase.kind === "idle") {
        const assignment = msg.payload.value;
        phase = { kind: "toIncident", assignment };
        log("simulator", `${ambulance.plate} -> ${assignment.incidentId}`);
        // Small delay so the central registers the assignment before the first report.
        setTimeout(
          () => report(assignment.incidentId, AmbulanceStatus.EN_ROUTE, etaTo(assignment.incidentLocation!), `${ambulance.plate} en camino al incidente`),
          500,
        );
      }
    }
  })().catch((err) => log("simulator", `${ambulance.plate} session ended: ${(err as Error).message}`));

  // Client-streaming GPS feed.
  const gpsStream = fleet.streamAmbulanceLocation(gps);

  while (true) {
    await sleep(TICK_MS);
    tick++;
    let moving = false;

    if (phase.kind === "toIncident" || phase.kind === "toHospital") {
      const target = phase.kind === "toIncident" ? phase.assignment.incidentLocation! : phase.assignment.hospitalLocation!;
      const { point, arrived } = stepTowards(position, target, STEP_KM);
      position = point;
      moving = true;
      const a = phase.assignment;
      if (arrived && phase.kind === "toIncident") {
        phase = { kind: "onScene", assignment: a, ticksLeft: SCENE_TICKS };
        report(a.incidentId, AmbulanceStatus.ON_SCENE, 0, "Equipo en el sitio, estabilizando paciente");
      } else if (arrived) {
        phase = { kind: "atHospital", assignment: a, ticksLeft: SCENE_TICKS };
        report(a.incidentId, AmbulanceStatus.AT_HOSPITAL, 0, `Paciente en ${a.hospitalName}`);
      } else if (tick % 3 === 0) {
        const status = phase.kind === "toIncident" ? AmbulanceStatus.EN_ROUTE : AmbulanceStatus.TRANSPORTING;
        report(a.incidentId, status, etaTo(target));
      }
    } else if (phase.kind === "onScene" && --phase.ticksLeft <= 0) {
      const a = phase.assignment;
      phase = { kind: "toHospital", assignment: a };
      report(a.incidentId, AmbulanceStatus.TRANSPORTING, etaTo(a.hospitalLocation!), `Trasladando paciente a ${a.hospitalName}`);
    } else if (phase.kind === "atHospital" && --phase.ticksLeft <= 0) {
      report(phase.assignment.incidentId, AmbulanceStatus.AVAILABLE, 0, "Paciente entregado. Ambulancia disponible");
      phase = { kind: "idle" };
    }

    // Moving ambulances report every tick; idle ones every 10 ticks (heartbeat).
    if (moving || tick % 10 === 0) {
      gps.push(
        create(LocationUpdateSchema, {
          ambulanceId: ambulance.id,
          location: position,
          speedKmh: moving ? 45 + Math.round(Math.random() * 25) : 0,
        }),
      );
    }

    if (await Promise.race([session.then(() => true), sleep(0).then(() => false)])) break;
  }
  gps.close();
  const summary = await gpsStream;
  log("simulator", `${ambulance.plate} disconnected after ${summary.updatesReceived} GPS updates`);
}

async function main() {
  let ambulances: Ambulance[] = [];
  while (!ambulances.length) {
    try {
      ambulances = (await fleet.listAmbulances({})).ambulances;
    } catch {
      log("simulator", "waiting for fleet service...");
      await sleep(1500);
    }
  }
  const count = Number(process.env.SIM_AMBULANCES ?? ambulances.length);
  log("simulator", `starting ${count} ambulances`);
  await Promise.all(
    ambulances.slice(0, count).map(async (a) => {
      for (;;) {
        await runAmbulance(a).catch((err) => log("simulator", `${a.plate} error: ${(err as Error).message}`));
        await sleep(3000); // reconnect
      }
    }),
  );
}

void main();
