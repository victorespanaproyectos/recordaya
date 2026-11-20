import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Permite forbidden() (403) para usuarios sin membresía o sin el rol necesario.
  experimental: {
    authInterrupts: true,
  },
};

export default nextConfig;
