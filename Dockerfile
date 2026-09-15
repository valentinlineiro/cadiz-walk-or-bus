FROM node:24-slim
WORKDIR /app
COPY worker.js server.js stops.json ./
COPY public ./public/
EXPOSE 8080
CMD ["node", "server.js"]
