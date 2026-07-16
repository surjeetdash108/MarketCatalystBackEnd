# ─── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# Install ALL deps (incl. dev) for the Nest build.
COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies so we copy a slim node_modules into the runtime image.
RUN npm prune --omit=dev

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Copy only what the server needs at runtime.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
# The ops monitor UI (ServeStaticModule serves this at /).
COPY public ./public

# Run as the built-in non-root user.
USER node

# Cloud Run injects PORT (8080); main.ts reads process.env.PORT. Documentational only.
EXPOSE 8080

# No service-account.json is shipped — the app uses Application Default Credentials
# from the Cloud Run runtime service account (grant it roles/datastore.user).
CMD ["node", "dist/main.js"]
