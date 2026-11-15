# ==============================================================================
# Stage 1: Install Backend Production Dependencies (Cached Layer)
# ==============================================================================
FROM node:20-alpine AS deps

WORKDIR /deps
COPY backend/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# ==============================================================================
# Stage 2: Application Runtime (Backend API + Realtime Engine + Frontend UI)
# ==============================================================================
FROM node:20-alpine

WORKDIR /app/backend

ENV NODE_ENV=production \
    PORT=3000 \
    FRONTEND_DIR=/app/frontend \
    TZ=Asia/Ho_Chi_Minh

# Copy backend source and prevent host node_modules/.env from leaking in
COPY backend/ /app/backend/
RUN rm -rf /app/backend/node_modules /app/backend/.env

# Copy clean Alpine-compatible node_modules from Stage 1
COPY --from=deps /deps/node_modules /app/backend/node_modules

# Copy frontend static files
COPY frontend/ /app/frontend/

# Ensure proper ownership for non-root execution
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Healthcheck against /api/db/status
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/db/status').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
