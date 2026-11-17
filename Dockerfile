# TireKicker: Fastify API + static frontend + Chromium for PDFs.
# Node 24 LTS runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=3000 \
    UPLOAD_DIR=/data/uploads

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps --only-shell chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY public ./public
COPY db/migrations ./db/migrations
COPY seed ./seed

RUN mkdir -p /data/uploads && chown -R node:node /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.ts"]
