# ─── Build stage ───────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install deps first (cache layer)
COPY package.json package-lock.json* ./
RUN npm install --ignore-optional 2>/dev/null || npm install

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/
COPY index.ts ./

# Build
RUN npx tsc

# ─── Runtime stage ─────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Non-root user for security and install procps for healthchecks
RUN apt-get update && apt-get install -y procps && rm -rf /var/lib/apt/lists/* && \
    groupadd -g 1001 botuser && \
    useradd -u 1001 -g botuser -s /bin/sh -m botuser

# Install production deps only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-optional 2>/dev/null || npm install --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Copy ML model
COPY src/ml/model ./src/ml/model

# Copy entrypoint script
COPY scripts/start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Create data directory
RUN mkdir -p /app/data && chown -R botuser:botuser /app

USER botuser

# Health check — ensure process is running
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -x node || exit 1

# Default: start.sh reads SERVICE_MODE to pick bot or dashboard
CMD ["/app/start.sh"]
