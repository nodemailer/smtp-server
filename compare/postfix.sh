#!/usr/bin/env bash
set -euo pipefail

# Manages the Postfix reference server used by compare/compare.js. The image is
# built from compare/Dockerfile and the container keeps running between
# comparisons.
#
# Usage: compare/postfix.sh start|stop|restart|status|logs
#
# Environment overrides:
#   SMTP_SERVER_POSTFIX_PORT  host port for SMTP (default 32025)

CONTAINER_NAME="smtp-server-postfix"
IMAGE="smtp-server-postfix:compare"
PORT="${SMTP_SERVER_POSTFIX_PORT:-32025}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

is_running() {
    [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)" = "true" ]
}

wait_ready() {
    echo "Waiting for Postfix to accept SMTP connections on port $PORT..."
    for _ in $(seq 1 30); do
        if node -e "
            const net = require('net');
            const socket = net.connect(Number(process.argv[1]), '127.0.0.1');
            const bail = code => { socket.destroy(); process.exit(code); };
            socket.on('data', chunk => bail(chunk.toString().startsWith('220 ') ? 0 : 1));
            socket.on('error', () => bail(1));
            setTimeout(() => bail(1), 2000);
        " "$PORT" 2>/dev/null; then
            echo "Postfix is ready on 127.0.0.1:$PORT"
            return 0
        fi
        sleep 1
    done
    echo "Postfix container did not become ready" >&2
    docker logs "$CONTAINER_NAME" >&2 || true
    exit 1
}

start() {
    if is_running; then
        echo "Postfix is already running on 127.0.0.1:$PORT (container $CONTAINER_NAME)"
        return 0
    fi
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

    # rebuilds are cached, so this is quick unless the Dockerfile changed
    docker build -q -t "$IMAGE" "$SCRIPT_DIR" >/dev/null

    docker run -d --name "$CONTAINER_NAME" -p "127.0.0.1:$PORT:25" "$IMAGE" >/dev/null

    wait_ready
}

stop() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    echo "Postfix stopped"
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart)
        stop
        start
        ;;
    status)
        if is_running; then
            echo "Postfix is running on 127.0.0.1:$PORT (container $CONTAINER_NAME)"
        else
            echo "Postfix is not running"
            exit 1
        fi
        ;;
    logs) docker logs "$CONTAINER_NAME" ;;
    *)
        echo "Usage: $0 start|stop|restart|status|logs" >&2
        exit 2
        ;;
esac
