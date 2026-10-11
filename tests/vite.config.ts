import base from '../apps/web/vite.config';
export default {
  ...base,
  envDir: false,
  server: { port: 5174, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:3002', ws: true } } },
};
