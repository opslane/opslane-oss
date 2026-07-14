# Stage 1: Build dashboard
FROM node:22-alpine AS dashboard-builder
WORKDIR /app
COPY packages/dashboard/package.json ./
RUN npm install
COPY packages/dashboard/ .
RUN npx vue-tsc && npx vite build

# Stage 2: Build Go service
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY packages/ingestion/go.mod packages/ingestion/go.sum ./
RUN go mod download
COPY packages/ingestion/ .
RUN CGO_ENABLED=0 go build -o /ingestion .

# Stage 3: Final image
FROM alpine:3.19
LABEL org.opencontainers.image.source="https://github.com/opslane/opslane-oss"
LABEL org.opencontainers.image.description="Opslane ingestion service"
RUN apk add --no-cache ca-certificates wget postgresql16-client
RUN addgroup -S ingestion && adduser -S ingestion -G ingestion
COPY --from=builder /ingestion /usr/local/bin/ingestion
COPY --from=builder /app/db/migrations /app/db/migrations
COPY scripts/run-migrations.sh /app/run-migrations.sh
COPY --from=dashboard-builder /app/dist /app/dashboard
ENV DASHBOARD_DIR=/app/dashboard
ENV PORT=8080
WORKDIR /app
USER ingestion
EXPOSE 8080
CMD ["ingestion"]
