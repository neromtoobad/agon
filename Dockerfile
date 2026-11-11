FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production TRIPOD_DB=/data/mainnet.db
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "src/cli.ts", "start"]
