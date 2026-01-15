# Production Dockerfile for Flux Flow Tracker
# Runs both Express API (port 3000) and SvelteKit Frontend (port 5173)

FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies for better-sqlite3 and runtime utilities
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite \
    sqlite-dev \
    pkgconfig \
    build-base \
    curl \
    wget

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install all dependencies with proper environment for better-sqlite3
ENV PYTHON=/usr/bin/python3
RUN npm install --legacy-peer-deps

# Rebuild better-sqlite3 for Alpine Linux
RUN npm rebuild better-sqlite3

# Copy ALL source code (including server.js at root and src/ directory)
COPY . .

# Build the SvelteKit frontend for production
RUN npm run build

# Create non-root user for security BEFORE setting permissions
RUN addgroup -g 1001 -S nodejs && \
    adduser -S fluxapp -u 1001

# Create ALL necessary directories with proper permissions
RUN mkdir -p /app/data && \
    mkdir -p /app/src/lib/db && \
    mkdir -p /app/static/logos && \
    mkdir -p /app/build && \
    chown -R fluxapp:nodejs /app && \
    chmod -R 775 /app/data

# Make startup script executable BEFORE switching user
RUN chmod +x /app/startup.sh

# Switch to non-root user
USER fluxapp

# Set production environment variables
ENV NODE_ENV=production
ENV HOST=0.0.0.0

# ========================================
# DATABASE CONFIGURATION
# ========================================
# CRITICAL: Set database to use the /app/data directory
ENV DATABASE_PATH=/app/data/flux-flow.db

# ========================================
# PORT CONFIGURATION
# ========================================
# Backend API port (Express server)
ENV API_PORT=3000

# Frontend port (SvelteKit)
ENV FRONTEND_PORT=5173

# CORS origin (update this for production if needed)
ENV ORIGIN=http://localhost:5173

# API base for hooks proxy
ENV API_BASE=http://127.0.0.1:3000

# ========================================
# EXPOSE PORTS
# ========================================
# API port
EXPOSE 3000
# Frontend port
EXPOSE 5173

# Volume for persistent data
VOLUME ["/app/data"]

# Health check for the API server
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start both services using the startup script
CMD ["/bin/sh", "/app/startup.sh"]