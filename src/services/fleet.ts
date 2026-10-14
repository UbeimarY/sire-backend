import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { AmbulanceStatus } from "../gen/sire/v1/common_pb.js";
import { AmbulanceSchema, FleetEventSchema, FleetService, type Ambulance, type FleetEvent } from "../gen/sire/v1/fleet_pb.js";
import { Broadcaster } from "../lib/broadcaster.js";
import { ports } from "../lib/config.js";
import { cityCenter, distanceKm } from "../lib/geo.js";
import { log } from "../lib/log.js";
import { startGrpcServer } from "../lib/server.js";

const crews = [
  "Paramédicos Ruiz y Torres",
  "Paramédicos Díaz y Castro",
  "Paramédicos Mora y Peña",
  "Paramédicos Rojas y León",
  "Paramédicos Vega y Ortiz",
  "Paramédicos Silva y Cruz",
];

// Initial fleet spread around the city center.
const ambulances = new Map<string, Ambulance>(
  crews.map((crew, i) => {
    const angle = (i / crews.length) * Math.PI * 2;
    const id = `amb-${String(i + 1).padStart(2, "0")}`;
    return [
      id,
      create(AmbulanceSchema, {
        id,
        plate: `SIR-${101 + i}`,
        crew,
        status: AmbulanceStatus.OFFLINE,
        location: { lat: cityCenter.lat + Math.sin(angle) * 0.045, lng: cityCenter.lng + Math.cos(angle) * 0.04 },
        updatedAtMs: BigInt(Date.now()),
      }),
    ];
  }),
);

const events = new Broadcaster<FleetEvent>();

function touch(ambulance: Ambulance) {
  ambulance.updatedAtMs = BigInt(Date.now());
  events.publish(create(FleetEventSchema, { ambulance }));
}

function getAmbulance(id: string): Ambulance {
  const ambulance = ambulances.get(id);
  if (!ambulance) throw new ConnectError(`Ambulancia ${id} no existe`, Code.NotFound);
  return ambulance;
}

startGrpcServer("fleet", ports.fleet, (router) =>
  router.service(FleetService, {
    listAmbulances() {
      return { ambulances: [...ambulances.values()] };
    },

    findNearestAmbulances(req) {
      if (!req.location) throw new ConnectError("location es obligatorio", Code.InvalidArgument);
      const target = req.location;
      const nearest = [...ambulances.values()]
        .filter((a) => a.status === AmbulanceStatus.AVAILABLE && a.location)
        .map((a) => ({ ambulance: a, distanceKm: distanceKm(a.location!, target) }))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, req.limit > 0 ? req.limit : 3);
      return { ambulances: nearest };
    },

    setAmbulanceStatus(req) {
      const ambulance = getAmbulance(req.ambulanceId);
      ambulance.status = req.status;
      ambulance.incidentId = req.incidentId;
      if (req.status === AmbulanceStatus.AVAILABLE || req.status === AmbulanceStatus.OFFLINE) ambulance.speedKmh = 0;
      touch(ambulance);
      return { ambulance };
    },

    // CLIENT STREAMING: one long-lived stream per ambulance with GPS points.
    async streamAmbulanceLocation(requests) {
      let updatesReceived = 0;
      let travelled = 0;
      let ambulanceId = "";
      for await (const update of requests) {
        const ambulance = getAmbulance(update.ambulanceId);
        ambulanceId = ambulance.id;
        if (update.location) {
          if (ambulance.location) travelled += distanceKm(ambulance.location, update.location);
          ambulance.location = update.location;
        }
        ambulance.speedKmh = update.speedKmh;
        updatesReceived++;
        touch(ambulance);
      }
      log("fleet", `location stream closed for ${ambulanceId}: ${updatesReceived} updates, ${travelled.toFixed(2)} km`);
      return { updatesReceived, distanceKm: travelled };
    },

    // SERVER STREAMING: snapshot of the fleet, then every change.
    async *watchFleet(_req, ctx) {
      const snapshot = [...ambulances.values()].map((ambulance) => create(FleetEventSchema, { ambulance }));
      yield* events.subscribe(ctx.signal, snapshot);
    },
  }),
);
