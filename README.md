# Auto Pal — Backend API

REST API for the **Auto Pal** vehicle maintenance app.

- **Runtime:** Node.js + TypeScript · **Framework:** Express
- **Database:** PostgreSQL via Prisma
- **Auth:** custom email/password with JWT access + refresh tokens
- **Files:** local disk storage (`uploads/`) via multer

The Prisma schema mirrors the app's local (Hive) models 1:1, and write verbs
use **`PUT /resource/:id`** with client-provided UUIDs so the offline-first app
can sync its locally-generated records straight up.

---

## Quick start

```bash
npm install
cp .env.example .env         # set DATABASE_URL + two JWT secrets (openssl rand -hex 32)
npm run prisma:migrate       # create tables + Prisma client
npm run db:seed              # optional demo user: demo@autopal.app / password123
npm run dev                  # http://localhost:4000
```

**Interactive API docs (Swagger UI):** http://localhost:4000/docs — click **Authorize**,
paste an `accessToken` from `/auth/login`, and try any endpoint. Raw spec at
`/openapi.json`.

Postgres via Docker: `docker run --name autopal-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=auto_pal -p 5432:5432 -d postgres:16`

Production: `npm run build && npm start`

---

## Auth

1. `POST /api/auth/register` or `/login` → `{ user, accessToken, refreshToken }`.
2. Send `Authorization: Bearer <accessToken>` on every request.
3. On expiry (15m), `POST /api/auth/refresh` with `{ refreshToken }`.

Everything except `/auth/*` and `/health` requires a token and is scoped to the
authenticated user.

---

## Endpoints (base `/api`)

**Auth** — `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh`

**Profile** — `GET /profile` · `PUT /profile` · `DELETE /profile`
· `POST /profile/photo` (multipart `photo`) · `GET /profile/photo` · `DELETE /profile/photo`

**Preferences** — `GET /preferences` · `PATCH /preferences`
(units, currency, backup settings)

**Vehicles** — `GET /vehicles` · `POST /vehicles` · `GET /vehicles/:id`
· `PUT /vehicles/:id` (create-or-update) · `PATCH /vehicles/:id`
· `DELETE /vehicles/:id` · `PATCH /vehicles/reorder` `{ orderedIds }`

**Trackers** (`/vehicles/:vehicleId/trackers`) — `GET /` · `GET /:id`
· `POST /` · `PUT /:id` · `PATCH /:id` · `DELETE /:id`

**Fuel records** (`/fuel-records`) — `GET /?vehicleId=` · `GET /:id`
· `PUT /:id` · `DELETE /:id`

**Service records** (`/service-records`) — `GET /?vehicleId=` · `GET /:id`
· `PUT /:id` · `DELETE /:id`
· `POST /:id/attachment` (multipart `attachment`) · `GET /:id/attachment`

**Reminders** (`/reminders`) — `GET /?vehicleId=` · `GET /:id`
· `PUT /:id` · `PATCH /:id` · `DELETE /:id`

**Documents** (`/documents`) — `GET /` · `GET /:id` · `POST /`
· `PATCH /:id` · `DELETE /:id`
· `POST /:id/file` (multipart `file`) · `GET /:id/file`

**Driving licence** (`/driving-licence`) — `GET /` · `PUT /` · `DELETE /`
(singleton — one per user)

**Backup & sync** — `GET /backup/export` (full bundle)
· `POST /backup/import` (upsert a bundle) · `GET /sync?since=<ISO>` (changed rows)

---

## Example

```bash
# Register → capture the accessToken
curl -X POST http://localhost:4000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"password123","displayName":"Me"}'

# Create a vehicle at a client-generated UUID
curl -X PUT http://localhost:4000/api/vehicles/6f9619ff-8b86-d011-b42d-00cf4fc964ff \
  -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"type":"petrol","vehicleType":"car","make":"Toyota","model":"Prius","year":2019,"licensePlate":"CAC 8515","currentMileage":119286}'

# Upload a service-record attachment
curl -X POST http://localhost:4000/api/service-records/<id>/attachment \
  -H "Authorization: Bearer $ACCESS" -F "attachment=@receipt.jpg"
```

---

## Project structure

```
src/
  index.ts · app.ts · env.ts · prisma.ts · routes.ts
  lib/        errors, jwt, password, asyncHandler, ownership, upload
  middleware/ authenticate, validate, errorHandler
  modules/    auth, profile, preferences, vehicles, trackers, fuel,
              service, reminders, documents, license, backup
prisma/       schema.prisma · seed.ts
uploads/      user files (git-ignored)
```

## Notes & next steps
- **Files** are stored on local disk under `uploads/<userId>/…` and streamed
  back through authenticated routes. Swap `src/lib/upload.ts` for S3/GCS to move
  to object storage — the route contracts stay the same.
- **Sync** (`/sync`) returns created/updated rows since a timestamp. Deletions
  are **not** tracked yet; add a tombstone table if the client needs to learn
  about server-side deletes.
- **Google Sign-In**: add `POST /auth/google` that verifies a Google ID token
  and issues our JWT pair (the user model is already compatible).
- **Refresh-token revocation** is stateless; add a `RefreshToken` table for
  server-side logout/blacklisting.
