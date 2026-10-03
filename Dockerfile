FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=4318
ENV POLL_INTERVAL_SECONDS=120
EXPOSE 4318
CMD ["npm", "run", "cloud"]
