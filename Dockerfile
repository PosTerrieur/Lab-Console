# Lab Console - small + unprivileged production image
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first for layer caching: --omit=optional skips ssh2's native
# cpu-features addon, so no compiler is needed (ssh2 falls back to pure JS)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY diagrams ./diagrams
COPY config ./config

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "src/server.js"]
