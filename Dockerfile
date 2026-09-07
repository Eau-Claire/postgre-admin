FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY README.md ./
ENV NODE_ENV=production
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "src/app.js"]
