#!/bin/sh

# Flux Flow Tracker Docker Entrypoint
# Starts both backend and frontend services

set -e

echo "========================================="
echo "Starting Flux Flow Tracker"
echo "========================================="

# Start backend API server in background
echo "Starting backend API server on port 3000..."
node server.js &
BACKEND_PID=$!

# Wait for backend to be ready
echo "Waiting for backend to be ready..."
until $(curl --output /dev/null --silent --head --fail http://localhost:3000/api/health); do
    printf '.'
    sleep 2
done
echo ""
echo "Backend is ready!"

# Start frontend preview server
echo "Starting frontend server on port 4173..."
npm run preview

# If frontend exits, kill backend
kill $BACKEND_PID
