FROM node:24-alpine
WORKDIR /app
COPY node_modules /app/node_modules
COPY model-gateway.mjs /app/model-gateway.mjs
CMD ["node","/app/model-gateway.mjs"]
