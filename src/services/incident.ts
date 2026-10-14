import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { z } from "zod";
import { AmbulanceStatus, IncidentStatus, TriageLevel } from "../gen/sire/v1/common_pb.js";
import {
  IncidentEventSchema,
  IncidentSchema,
  IncidentService,
  TimelineEntrySchema,
  type Incident,
  type IncidentEvent,
} from "../gen/sire/v1/incident_pb.js";
import { Broadcaster } from "../lib/broadcaster.js";
import { dispatchClient, fleetClient, hospitalClient } from "../lib/clients.js";
import { ports } from "../lib/config.js";
import { log } from "../lib/log.js";
import { startGrpcServer } from "../lib/server.js";

const fleet = fleetClient();
const hospitals = hospitalClient();
const dispatch = dispatchClient();

const incidents = new Map<string, Incident>();
const onSceneAt = new Map<string, number>();
const events = new Broadcaster<IncidentEvent>();
let sequence = 1000;

// Runtime validation (TypeScript types disappear at runtime: "parse, don't validate").
const createIncidentInput = z.object({
  description: z.string().trim().min(5, "La descripción debe tener al menos 5 caracteres").max(500),
  address: z.string().trim().min(3, "La dirección es obligatoria").max(200),
  callerName: z.string().trim().max(100),
  callerPhone: z.string().trim().regex(/^[0-9+\s-]{0,20}$/, "Teléfono inválido"),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  triage: z.nativeEnum(TriageLevel).refine((t) => t !== TriageLevel.UNSPECIFIED, "Seleccione un nivel de triage"),
});

const activeStatuses = new Set([
  IncidentStatus.PENDING,
  IncidentStatus.ASSIGNED,
  IncidentStatus.EN_ROUTE,
  IncidentStatus.ON_SCENE,
  IncidentStatus.TRANSPORTING,
  IncidentStatus.AT_HOSPITAL,
]);

function getIncident(id: string): Incident {
  const incident = incidents.get(id);
  if (!incident) throw new ConnectError(`Incidente ${id} no existe`, Code.NotFound);
  return incident;
}

function record(incident: Incident, status: IncidentStatus, note: string) {
  const now = BigInt(Date.now());
  incident.status = status;
  incident.updatedAtMs = now;
  incident.timeline.push(create(TimelineEntrySchema, { status, note, atMs: now }));
  events.publish(create(IncidentEventSchema, { incident }));
}

// Assignments run one at a time so two incidents never get the same ambulance.
let assignmentQueue = Promise.resolve();
function scheduleAssignment(incident: Incident) {
  assignmentQueue = assignmentQueue.then(() =>
    tryAssign(incident).catch((err) => log("incident", `assignment error ${incident.id}: ${(err as Error).message}`)),
  );
  return assignmentQueue;
}

/** Orchestration: Fleet (nearest ambulance) + Hospital (bed) + Dispatch (push assignment). */
async function tryAssign(incident: Incident) {
  if (incident.status !== IncidentStatus.PENDING || !incident.location) return;

  const { options } = await hospitals.getAvailableHospitals({ near: incident.location, triage: incident.triage });
  const hospital = options[0]?.hospital;
  if (!hospital?.location) {
    noteOnce(incident, "Sin camas disponibles en la red hospitalaria, en espera");
    return;
  }

  const { ambulances } = await fleet.findNearestAmbulances({ location: incident.location, limit: 5 });
  for (const { ambulance, distanceKm } of ambulances) {
    if (!ambulance) continue;
    const { delivered } = await dispatch.assignAmbulance({
      ambulanceId: ambulance.id,
      assignment: {
        incidentId: incident.id,
        description: incident.description,
        triage: incident.triage,
        incidentLocation: incident.location,
        hospitalId: hospital.id,
        hospitalName: hospital.name,
        hospitalLocation: hospital.location,
      },
    });
    if (!delivered) continue;

    await fleet.setAmbulanceStatus({ ambulanceId: ambulance.id, status: AmbulanceStatus.EN_ROUTE, incidentId: incident.id });
    await hospitals.reserveBed({
      hospitalId: hospital.id,
      patient: {
        incidentId: incident.id,
        triage: incident.triage,
        description: incident.description,
        ambulanceId: ambulance.id,
        ambulancePlate: ambulance.plate,
        status: IncidentStatus.ASSIGNED,
      },
    });
    incident.ambulanceId = ambulance.id;
    incident.hospitalId = hospital.id;
    incident.hospitalName = hospital.name;
    record(
      incident,
      IncidentStatus.ASSIGNED,
      `Ambulancia ${ambulance.plate} asignada (${distanceKm.toFixed(1)} km). Destino: ${hospital.name}`,
    );
    return;
  }
  noteOnce(incident, "Sin ambulancias disponibles, en cola de espera");
}

function noteOnce(incident: Incident, note: string) {
  if (incident.timeline.at(-1)?.note !== note) record(incident, IncidentStatus.PENDING, note);
}

// Retry pending incidents (most critical first) every few seconds.
setInterval(() => {
  const pending = [...incidents.values()]
    .filter((i) => i.status === IncidentStatus.PENDING)
    .sort((a, b) => a.triage - b.triage || Number(a.createdAtMs - b.createdAtMs));
  for (const incident of pending) void scheduleAssignment(incident);
}, 4000);

startGrpcServer("incident", ports.incident, (router) =>
  router.service(IncidentService, {
    async createIncident(req) {
      const parsed = createIncidentInput.safeParse(req);
      if (!parsed.success) {
        throw new ConnectError(parsed.error.issues.map((i) => i.message).join("; "), Code.InvalidArgument);
      }
      const input = parsed.data;
      const now = BigInt(Date.now());
      const incident = create(IncidentSchema, {
        id: `INC-${++sequence}`,
        ...input,
        status: IncidentStatus.PENDING,
        createdAtMs: now,
        updatedAtMs: now,
      });
      incidents.set(incident.id, incident);
      record(incident, IncidentStatus.PENDING, "Emergencia registrada por la central");
      await scheduleAssignment(incident);
      return { incident };
    },

    getIncident(req) {
      return { incident: getIncident(req.id) };
    },

    listIncidents() {
      return { incidents: [...incidents.values()].reverse() };
    },

    async updateIncidentStatus(req) {
      const incident = getIncident(req.incidentId);
      incident.etaSeconds = req.etaSeconds;
      if (req.status === IncidentStatus.ON_SCENE && !onSceneAt.has(incident.id)) onSceneAt.set(incident.id, Date.now());
      const statusChanged = incident.status !== req.status;
      if (statusChanged) {
        record(incident, req.status, req.note);
      } else {
        incident.updatedAtMs = BigInt(Date.now());
        events.publish(create(IncidentEventSchema, { incident }));
      }
      if (incident.hospitalId) {
        await hospitals.updateIncomingPatient({
          hospitalId: incident.hospitalId,
          incidentId: incident.id,
          status: req.status,
          etaSeconds: req.etaSeconds,
        });
      }
      return { incident };
    },

    async *watchIncidents(_req, ctx) {
      const snapshot = [...incidents.values()].map((incident) => create(IncidentEventSchema, { incident }));
      yield* events.subscribe(ctx.signal, snapshot);
    },

    getMetrics() {
      const all = [...incidents.values()];
      const responseTimes = all
        .filter((i) => onSceneAt.has(i.id))
        .map((i) => (onSceneAt.get(i.id)! - Number(i.createdAtMs)) / 1000);
      const byTriage = [TriageLevel.I, TriageLevel.II, TriageLevel.III, TriageLevel.IV, TriageLevel.V].map((triage) => ({
        triage,
        count: all.filter((i) => i.triage === triage).length,
      }));
      return {
        totalIncidents: all.length,
        activeIncidents: all.filter((i) => activeStatuses.has(i.status)).length,
        closedIncidents: all.filter((i) => i.status === IncidentStatus.CLOSED).length,
        pendingIncidents: all.filter((i) => i.status === IncidentStatus.PENDING).length,
        avgResponseSeconds: responseTimes.length ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0,
        byTriage,
      };
    },
  }),
);
