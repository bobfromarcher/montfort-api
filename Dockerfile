FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY api/ ./api/

EXPOSE 3100

CMD ["node", "api/server.js"]
