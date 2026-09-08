# syntax=docker/dockerfile:1

# ─── dependencies ────────────────────────────────────────
# Every workspace manifest, so the lockfile resolves the same tree it does on
# a developer's machine. Split from the source copy so editing a .ts file does
# not re-run npm install.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/tenant-web/package.json ./apps/tenant-web/package.json
COPY apps/admin-web/package.json ./apps/admin-web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci --workspace @dentalcare/api --include-workspace-root

# ─── build stage ─────────────────────────────────────────
# @dentalcare/shared first: the API imports it, and npm has linked
# node_modules/@dentalcare/shared at the workspace directory, so its dist has
# to exist before tsc resolves the import.
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
RUN npm run build -w @dentalcare/shared
COPY apps/api ./apps/api
RUN npm run build -w @dentalcare/api

# ─── migration runner ────────────────────────────────────
#
# A separate image, not a separate command on the serving image.
#
# Migrations need node-pg-migrate, which is a devDependency, and the migration
# files themselves, which the API never reads. Putting either into the image
# that serves traffic would mean shipping the tool that can rewrite the schema
# alongside the process that is exposed to the internet, for no gain — the
# serving image below is unchanged by this stage existing.
#
# It reuses the `deps` layer, so the full dependency tree is already there and
# this costs one small COPY rather than a second install.
FROM deps AS migrate
WORKDIR /app
COPY apps/api/migrations ./apps/api/migrations
COPY apps/api/scripts ./apps/api/scripts
USER node
CMD ["node", "apps/api/scripts/container-init.js"]

# ─── runtime stage ───────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/package.json
# The manifest, so npm creates the workspace link the API's `require` follows.
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci --omit=dev --workspace @dentalcare/api --include-workspace-root

COPY --from=build /app/apps/api/dist ./apps/api/dist
# The built shared package, and only its build output — no sources, no tests.
COPY --from=build /app/packages/shared/dist ./packages/shared/dist

# Drop privileges — the node image ships an unprivileged `node` user.
USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
