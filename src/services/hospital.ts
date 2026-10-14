import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { IncidentStatus, TriageLevel } from "../gen/sire/v1/common_pb.js";
import {
  HospitalEventSchema,
  HospitalSchema,
  HospitalService,
  IncomingPatientEventSchema,
  IncomingPatientSchema,
  type Hospital,
  type HospitalEvent,
  type IncomingPatient,
  type IncomingPatientEvent,
} from "../gen/sire/v1/hospital_pb.js";
import { Broadcaster } from "../lib/broadcaster.js";
import { ports } from "../lib/config.js";
import { cityCenter, distanceKm } from "../lib/geo.js";
import { startGrpcServer } from "../lib/server.js";

// Fictional hospitals placed around the demo city center.
const hospitals = new Map<string, Hospital>(
  [
    { id: "h1", name: "Hospital Central", address: "Av. Principal #10-20", dLat: 0.005, dLng: 0.012, beds: 12 },
    { id: "h2", name: "Clínica del Norte", address: "Calle 120 #15-30", dLat: 0.06, dLng: 0.02, beds: 8 },
    { id: "h3", name: "Hospital del Sur", address: "Autopista Sur #40-12", dLat: -0.055, dLng: -0.02, beds: 10 },
    { id: "h4", name: "Clínica Occidente", address: "Av. Occidente #68-45", dLat: 0.01, dLng: -0.06, beds: 6 },
  ].map((h) => [
    h.id,
    create(HospitalSchema, {
      id: h.id,
      name: h.name,
      address: h.address,
      location: { lat: cityCenter.lat + h.dLat, lng: cityCenter.lng + h.dLng },
      totalBeds: h.beds,
      availableBeds: Math.ceil(h.beds * 0.6),
    }),
  ]),
);

// hospitalId -> (incidentId -> patient)
const incoming = new Map<string, Map<string, IncomingPatient>>();
const hospitalEvents = new Broadcaster<HospitalEvent>();
const patientEvents = new Broadcaster<{ hospitalId: string; event: IncomingPatientEvent }>();

function getHospital(id: string): Hospital {
  const hospital = hospitals.get(id);
  if (!hospital) throw new ConnectError(`Hospital ${id} no existe`, Code.NotFound);
  return hospital;
}

function publishHospital(hospital: Hospital) {
  hospitalEvents.publish(create(HospitalEventSchema, { hospital }));
}

function publishPatient(hospitalId: string, patient: IncomingPatient, removed = false) {
  patientEvents.publish({ hospitalId, event: create(IncomingPatientEventSchema, { patient, removed }) });
}

startGrpcServer("hospital", ports.hospital, (router) =>
  router.service(HospitalService, {
    listHospitals() {
      return { hospitals: [...hospitals.values()] };
    },

    // Critical patients (triage I/II) can take the last bed; others leave one bed free.
    getAvailableHospitals(req) {
      if (!req.near) throw new ConnectError("near es obligatorio", Code.InvalidArgument);
      const near = req.near;
      const critical = req.triage === TriageLevel.I || req.triage === TriageLevel.II;
      const options = [...hospitals.values()]
        .filter((h) => h.availableBeds > (critical ? 0 : 1))
        .map((hospital) => ({ hospital, distanceKm: distanceKm(hospital.location!, near) }))
        .sort((a, b) => a.distanceKm - b.distanceKm);
      return { options };
    },

    reserveBed(req) {
      const hospital = getHospital(req.hospitalId);
      if (hospital.availableBeds <= 0) throw new ConnectError(`${hospital.name} sin camas`, Code.ResourceExhausted);
      if (!req.patient) throw new ConnectError("patient es obligatorio", Code.InvalidArgument);
      hospital.availableBeds--;
      const patients = incoming.get(hospital.id) ?? new Map<string, IncomingPatient>();
      incoming.set(hospital.id, patients);
      const patient = create(IncomingPatientSchema, { ...req.patient, updatedAtMs: BigInt(Date.now()) });
      patients.set(patient.incidentId, patient);
      publishHospital(hospital);
      publishPatient(hospital.id, patient);
      return { hospital };
    },

    updateIncomingPatient(req) {
      const patient = incoming.get(req.hospitalId)?.get(req.incidentId);
      if (!patient) return {};
      patient.status = req.status;
      patient.etaSeconds = req.etaSeconds;
      patient.updatedAtMs = BigInt(Date.now());
      const done = req.status === IncidentStatus.CLOSED;
      if (done) incoming.get(req.hospitalId)?.delete(req.incidentId);
      publishPatient(req.hospitalId, patient, done);
      return {};
    },

    updateBeds(req) {
      const hospital = getHospital(req.hospitalId);
      if (req.availableBeds < 0 || req.availableBeds > hospital.totalBeds) {
        throw new ConnectError(`Camas debe estar entre 0 y ${hospital.totalBeds}`, Code.InvalidArgument);
      }
      hospital.availableBeds = req.availableBeds;
      publishHospital(hospital);
      return { hospital };
    },

    async *watchHospitals(_req, ctx) {
      const snapshot = [...hospitals.values()].map((hospital) => create(HospitalEventSchema, { hospital }));
      yield* hospitalEvents.subscribe(ctx.signal, snapshot);
    },

    async *watchIncomingPatients(req, ctx) {
      getHospital(req.hospitalId);
      const snapshot = [...(incoming.get(req.hospitalId)?.values() ?? [])].map((patient) => ({
        hospitalId: req.hospitalId,
        event: create(IncomingPatientEventSchema, { patient }),
      }));
      for await (const item of patientEvents.subscribe(ctx.signal, snapshot)) {
        if (item.hospitalId === req.hospitalId) yield item.event;
      }
    },
  }),
);
