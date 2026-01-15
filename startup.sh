#!/bin/sh
# Startup script for Flux Flow Tracker
# Runs both the Express API server and SvelteKit frontend

set -e

echo "🚀 Starting Flux Flow Tracker..."
echo "========================================"

# Ensure database directory exists and has correct permissions
echo "📁 Checking database directory..."
if [ ! -d "/app/data" ]; then
    echo "⚠️  Creating /app/data directory..."
    mkdir -p /app/data
fi

# Check if we can write to the data directory
if [ ! -w "/app/data" ]; then
    echo "❌ ERROR: Cannot write to /app/data directory"
    echo "   This may be a permissions issue with the volume mount"
    ls -la /app/ | grep data
    exit 1
fi

echo "✅ Database directory is ready: /app/data"
echo "   Database will be created at: ${DATABASE_PATH:-/app/data/flux-flow.db}"

# Start the Express API server in the background
echo "📡 Starting API server on port ${API_PORT:-3000}..."
PORT=${API_PORT:-3000} node server.js &
API_PID=$!

echo "   API server started with PID: $API_PID"

# Wait for API to be ready (with timeout)
echo "⏳ Waiting for API server to be ready..."
MAX_TRIES=30
TRIES=0
until curl --output /dev/null --silent --head --fail http://localhost:${API_PORT:-3000}/api/health; do
    printf '.'
    sleep 2
    TRIES=$((TRIES + 1))
    if [ $TRIES -ge $MAX_TRIES ]; then
        echo ""
        echo "❌ ERROR: API server failed to start within 60 seconds"
        echo "   Checking if API process is still running..."
        if ! kill -0 $API_PID 2>/dev/null; then
            echo "   API process died. Check logs above for errors."
        fi
        exit 1
    fi
done
echo ""
echo "✅ API server is ready!"

# Start the SvelteKit frontend (using the built app)
echo "🎨 Starting frontend on port ${FRONTEND_PORT:-5173}..."
PORT=${FRONTEND_PORT:-5173} HOST=${HOST:-0.0.0.0} node build/index.js &
FRONTEND_PID=$!

echo "   Frontend started with PID: $FRONTEND_PID"

# Give frontend a moment to start
sleep 3

echo "✅ Both services started successfully!"
echo "========================================"
echo "   API: http://localhost:${API_PORT:-3000}"
echo "   Frontend: http://localhost:${FRONTEND_PORT:-5173}"
echo "   Database: ${DATABASE_PATH:-/app/data/flux-flow.db}"
echo "   API PID: $API_PID"
echo "   Frontend PID: $FRONTEND_PID"
echo "========================================"

# Function to handle shutdown
cleanup() {
    echo ""
    echo "🛑 Shutting down services..."
    kill $API_PID $FRONTEND_PID 2>/dev/null || true
    wait $API_PID $FRONTEND_PID 2>/dev/null || true
    echo "✅ Services stopped cleanly"
    exit 0
}

# Set up signal handlers
trap cleanup SIGTERM SIGINT

# Wait for any process to exit
wait -n

# If we get here, one of the processes exited
EXIT_CODE=$?
echo "⚠️  One of the services exited with code: $EXIT_CODE"
cleanup