# Kaustubh Kale · Portfolio

A static portfolio with seven project case studies, screenshots, architecture
diagrams, and source links.

```sh
npm ci
npm run dev
```

Run `npm run build` to export the site to `out/`. For Vercel, the static build
and output directory are set in `vercel.json`.

Edit the profile and project content in `content/` and the screenshots in
`public/media/`. Use `npm test`, `npm run lint`, and `npm run typecheck` to check
changes. Run `npm run test:e2e:install` before the first `npm run test:e2e`.
