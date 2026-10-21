FROM node:22-alpine

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

WORKDIR /app
COPY server.js .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
