# ─── Build stage ───────────────────────────────────────────
FROM node:20-alpine AS builder

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
FROM node:20-alpine

WORKDIR /app

# Non-root user for security
RUN addgroup -g 1001 -S botuser && \
    adduser -u 1001 -S botuser -G botuser

# Install production deps only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-optional 2>/dev/null || npm install --omit=dev

# Copy compiled JS from builder
COPY --from=builder /app/dist ./dist

# Create data directory
RUN mkdir -p /app/data && chown -R botuser:botuser /app

USER botuser

# Health check — ensure process is running
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD pgrep -x node || exit 1

CMD ["node", "dist/src/index.js"]
