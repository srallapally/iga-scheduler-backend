FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY migrations ./migrations

USER node
ENV NODE_ENV=production
CMD ["node", "src/main.js"]
