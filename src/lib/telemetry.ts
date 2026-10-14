import { create } from "@bufbuild/protobuf";
import { AmbulanceStatus } from "../gen/sire/v1/common_pb.js";
import { GetTelemetryResponseSchema, type GetTelemetryResponse } from "../gen/sire/v1/benchmark_pb.js";
import { cityCenter } from "./geo.js";

/** Deterministic synthetic telemetry so REST and gRPC return identical data. */
export function buildTelemetry(count: number): GetTelemetryResponse {
  const safeCount = Math.min(Math.max(Math.trunc(count) || 100, 1), 5000);
  let seed = 42;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const base = 1_790_000_000_000;
  return create(GetTelemetryResponseSchema, {
    samples: Array.from({ length: safeCount }, (_, i) => ({
      ambulanceId: `amb-${String((i % 6) + 1).padStart(2, "0")}`,
      location: { lat: cityCenter.lat + (random() - 0.5) * 0.1, lng: cityCenter.lng + (random() - 0.5) * 0.1 },
      speedKmh: Math.round(random() * 800) / 10,
      heartRate: 60 + Math.floor(random() * 80),
      oxygenSaturation: 85 + Math.floor(random() * 15),
      timestampMs: BigInt(base + i * 1000),
      status: 1 + Math.floor(random() * 5) as AmbulanceStatus,
    })),
  });
}
