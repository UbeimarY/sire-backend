import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { AmbulanceStatus, IncidentStatus } from "../gen/sire/v1/common_pb.js";
import { DispatchMessageSchema, DispatchService, type DispatchMessage } from "../gen/sire/v1/dispatch_pb.js";
import { Broadcaster } from "../lib/broadcaster.js";
import { fleetClient, incidentClient } from "../lib/clients.js";
import { ports } from "../lib/config.js";
import { log } from "../lib/log.js";
import { startGrpcServer } from "../lib/server.js";

const fleet = fleetClient();
const incidents = incidentClient();

// One outbound channel per connected ambulance (bidirectional session).
const sessions = new Map<string, Broadcaster<DispatchMessage>>();

// Ambulance status -> incident status.
const incidentStatusFor: Partial<Record<AmbulanceStatus, IncidentStatus>> = {
  [AmbulanceStatus.EN_ROUTE]: IncidentStatus.EN_ROUTE,
  [AmbulanceStatus.ON_SCENE]: IncidentStatus.ON_SCENE,
  [AmbulanceStatus.TRANSPORTING]: IncidentStatus.TRANSPORTING,
  [AmbulanceStatus.AT_HOSPITAL]: IncidentStatus.AT_HOSPITAL,
};

startGrpcServer("dispatch", ports.dispatch, (router) =>
  router.service(DispatchService, {
    // BIDIRECTIONAL STREAMING: assignments go down, status reports come up.
    async *ambulanceSession(requests, ctx) {
      const iterator = requests[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value.payload.case !== "hello") {
        throw new ConnectError("El primer mensaje debe ser hello", Code.InvalidArgument);
      }
      const ambulanceId = first.value.payload.value.ambulanceId;
      const outbound = new Broadcaster<DispatchMessage>();
      sessions.set(ambulanceId, outbound);
      await fleet.setAmbulanceStatus({ ambulanceId, status: AmbulanceStatus.AVAILABLE, incidentId: "" });
      log("dispatch", `session opened: ${ambulanceId} (${sessions.size} online)`);

      // The session ends when the client disconnects or closes its side of the stream.
      const session = new AbortController();
      ctx.signal.addEventListener("abort", () => session.abort());

      // Consume inbound status reports concurrently with the outbound stream.
      const inbound = (async () => {
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
          const msg = next.value;
          if (msg.payload.case !== "status") continue;
          const report = msg.payload.value;
          await fleet.setAmbulanceStatus({
            ambulanceId,
            status: report.status,
            incidentId: report.status === AmbulanceStatus.AVAILABLE ? "" : report.incidentId,
          });
          const incidentStatus =
            report.status === AmbulanceStatus.AVAILABLE ? IncidentStatus.CLOSED : incidentStatusFor[report.status];
          if (report.incidentId && incidentStatus) {
            await incidents.updateIncidentStatus({
              incidentId: report.incidentId,
              status: incidentStatus,
              etaSeconds: report.etaSeconds,
              note: report.note,
            });
          }
        }
      })()
        .catch((err) => log("dispatch", `inbound error ${ambulanceId}: ${(err as Error).message}`))
        .finally(() => session.abort());

      try {
        const welcome = create(DispatchMessageSchema, {
          payload: { case: "welcome", value: { message: `Unidad ${ambulanceId} conectada a la central SIRE` } },
        });
        yield* outbound.subscribe(session.signal, [welcome]);
      } finally {
        sessions.delete(ambulanceId);
        await fleet
          .setAmbulanceStatus({ ambulanceId, status: AmbulanceStatus.OFFLINE, incidentId: "" })
          .catch(() => undefined);
        log("dispatch", `session closed: ${ambulanceId}`);
      }
    },

    assignAmbulance(req) {
      const session = sessions.get(req.ambulanceId);
      if (!session || !req.assignment) return { delivered: false };
      session.publish(create(DispatchMessageSchema, { payload: { case: "assignment", value: req.assignment } }));
      return { delivered: true };
    },

    listSessions() {
      return { ambulanceIds: [...sessions.keys()] };
    },
  }),
);
