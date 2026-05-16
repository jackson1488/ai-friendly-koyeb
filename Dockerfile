FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
ENV DATABASE_URL=file:/data/prod.db
ENV DB_BACKUP_DIR=/data/backups/db
ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tar gzip \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci

COPY src ./src
COPY uploads/.gitkeep ./uploads/.gitkeep
COPY logs/.gitkeep ./logs/.gitkeep

RUN mkdir -p /data /data/backups/db /app/uploads /app/logs

EXPOSE 4000

CMD ["npm", "run", "start:koyeb"]

