import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { DescService } from "@bufbuild/protobuf";
import { AuthService } from "../gen/sire/v1/auth_pb.js";
import { FleetService } from "../gen/sire/v1/fleet_pb.js";
import { HospitalService } from "../gen/sire/v1/hospital_pb.js";
import { DispatchService } from "../gen/sire/v1/dispatch_pb.js";
import { IncidentService } from "../gen/sire/v1/incident_pb.js";
import { urls } from "./config.js";

/** Service-to-service clients: native gRPC (Protobuf binary over HTTP/2). */
function grpcClient<T extends DescService>(service: T, baseUrl: string): Client<T> {
  return createClient(service, createGrpcTransport({ baseUrl }));
}

export const authClient = () => grpcClient(AuthService, urls.auth);
export const fleetClient = () => grpcClient(FleetService, urls.fleet);
export const hospitalClient = () => grpcClient(HospitalService, urls.hospital);
export const dispatchClient = () => grpcClient(DispatchService, urls.dispatch);
export const incidentClient = () => grpcClient(IncidentService, urls.incident);
