# Pre-built Vite (web) bundle for the Maestro desktop renderer, served by nginx.
# Build context = deploy/desktop-web (html/ is produced by `vite build --config vite.web.config.ts`).
FROM nginx:alpine
RUN rm -rf /usr/share/nginx/html/*
COPY html/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
