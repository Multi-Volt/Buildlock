FROM node:20-alpine
WORKDIR /app
COPY . .
ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "server.js", "--warm"]
