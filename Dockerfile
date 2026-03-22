# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: production ──────────────────────────────────────────────────────
FROM node:22-alpine AS prod
WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy compiled output and static assets
COPY --from=builder /app/dist ./dist
COPY public/ ./public/

# Create persistent state directory
RUN mkdir -p /app/data

# Run as non-root
RUN addgroup -S bonzo && adduser -S bonzo -G bonzo && chown -R bonzo:bonzo /app
USER bonzo

EXPOSE 3000

CMD ["node", "dist/server.js"]
