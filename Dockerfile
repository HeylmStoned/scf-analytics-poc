FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 SEED_DEMO=0
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
EXPOSE 8080
CMD ["npx", "tsx", "src/server.ts"]
