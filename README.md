# SIRE · Backend (microservicios gRPC)

Backend del **Sistema Integrado de Respuesta a Emergencias**: despacho de ambulancias en tiempo real con **gRPC**.
El frontend vive en un repositorio separado (`sire-frontend`) y se conecta por **gRPC-Web**.

> Taller gRPC · Programación Orientada a la Web · Universidad Cooperativa de Colombia

## Arquitectura

```
 Frontend (otro repo) ── gRPC-Web ──► Gateway :PORT  (traduce gRPC-Web → gRPC, autentica, autoriza; rol de Envoy)
                                          │ gRPC nativo (HTTP/2)
                                          ├──► AuthService      :50051
                                          ├──► FleetService     :50052
                                          ├──► HospitalService  :50053
                                          ├──► DispatchService  :50054
                                          └──► IncidentService  :50055 ──gRPC──► Fleet, Hospital, Dispatch
 Simulador de ambulancias ── gRPC nativo ──► Fleet (client streaming) + Dispatch (bidireccional)
```

Cada microservicio es un **proceso independiente** con su propio servidor gRPC sobre HTTP/2. `src/launcher.ts` los arranca todos dentro de un solo contenedor.

| Tipo de llamada | RPC | Uso |
|---|---|---|
| Unaria | `CreateIncident`, `FindNearestAmbulances`, `ReserveBed`, `AssignAmbulance`… | Operaciones y llamadas entre servicios |
| Server streaming | `WatchIncidents`, `WatchFleet`, `WatchHospitals`, `WatchIncomingPatients` | Tableros en vivo del frontend |
| Client streaming | `FleetService.StreamAmbulanceLocation` | GPS continuo de cada ambulancia |
| Bidireccional | `DispatchService.AmbulanceSession` | Asignaciones ↓ y reportes de estado ↑ |

Conceptos aplicados: **contract-first** (`proto/` es la fuente única de verdad y el código se genera con `buf`), **tipado end-to-end** (tipos generados en todos los servicios), **validación en runtime con Zod** (`IncidentService`) y **benchmark REST vs gRPC** (`GET /api/rest/telemetry` frente a `BenchmarkService.GetTelemetry`).

## Estructura

```
proto/sire/v1/        Contratos .proto
src/services/         auth, fleet, hospital, dispatch, incident
src/gateway.ts        Gateway público gRPC-Web + CORS + /health
src/simulator.ts      Simulador de 6 ambulancias
src/launcher.ts       Arranca todos los procesos
src/gen/              Código generado (no editar)
Dockerfile, render.yaml
```

## Ejecutar en local

```bash
npm install
npm run dev        # gateway en http://localhost:8080
```

Después de cambiar un `.proto`: `npm run generate`.

Usuarios (contraseña `sire2026`): `operador`, `admin`, `hospital.central`, `hospital.norte`, `hospital.sur`, `hospital.occidente`.

## Desplegar

**Render:** New → Blueprint → este repositorio (usa `render.yaml`). Al terminar, copia la URL pública (ej. `https://sire-backend.onrender.com`); la necesita el frontend. Comprueba que responde en `/health`.

**Railway:** New Project → Deploy from GitHub repo → este repositorio. Railway detecta el `Dockerfile`. Luego *Settings → Networking → Generate Domain*.

En el plan gratuito de Render el servicio se duerme sin uso: abre `/health` un minuto antes de la demo.

| Variable | Descripción |
|---|---|
| `PORT` | La inyecta la plataforma; ahí escucha el gateway |
| `JWT_SECRET` | Secreto para firmar los tokens |
| `ALLOWED_ORIGINS` | Orígenes CORS permitidos (`*` o la URL del frontend) |
| `SIM_ENABLED` | `false` para no iniciar el simulador |
| `SIM_STEP_KM` | Km por segundo de las ambulancias simuladas (0.12) |
| `CITY_CENTER_LAT`, `CITY_CENTER_LNG` | Centro de la demo (Bogotá por defecto) |
