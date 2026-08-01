# ─── build stage ─────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Install deps using the workspace manifests
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm install

# Compile the API
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
RUN npm run build -w @dentalcare/api

# ─── runtime stage ───────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm install --omit=dev

COPY --from=build /app/apps/api/dist ./apps/api/dist

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
