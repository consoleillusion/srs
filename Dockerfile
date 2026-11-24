# SRS server image. Mount your project (schemas plus the `.srs/` folder written
# by `srs init`) at /project and your data at /data:
#
#   docker run -p 5734:5734 --env-file .env \
#     -v "$PWD":/project:ro -v srs-data:/data -v srs-backups:/backups srs
#
# Run one container per database: the database file is locked by the process
# that opens it, so a second container on the same volume cannot start.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    DB_PATH=/data/srs.db \
    SRS_BACKUP_DIR=/backups \
    PORT=5734
RUN mkdir -p /data /backups /project && chown -R bun:bun /data /backups
USER bun
WORKDIR /project
VOLUME ["/data", "/backups"]
EXPOSE 5734

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT ?? 5734) + '/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["bun", "/app/src/cli.ts"]
CMD ["serve"]
