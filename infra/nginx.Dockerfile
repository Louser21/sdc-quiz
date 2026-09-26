# Production nginx: base alpine image + curl so the container healthcheck can
# probe the local HTTPS listener (busybox `wget` in the base image has no TLS).
FROM nginx:1.27-alpine

RUN apk add --no-cache curl