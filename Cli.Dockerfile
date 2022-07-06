FROM node:8.17.0-alpine

WORKDIR /app

COPY package.json /app
COPY package-lock.json /app

RUN npm ci && npm cache clean --force

COPY . /app

RUN npm run build

ENTRYPOINT ["node", "--stack_trace_limit=100", "--max-old-space-size=4096", "/app/dist/cli/index.js"]