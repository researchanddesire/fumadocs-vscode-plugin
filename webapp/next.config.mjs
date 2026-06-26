/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Content is read from an arbitrary directory at request time, so nothing is
  // statically analyzable. Keep everything dynamic and never cache.
  experimental: {
    // Allow importing files that live outside this app's root (the content
    // directory the user is previewing).
  },
  // Preview content can reference images from literally anywhere, so disable
  // the optimizer's allowlist entirely and accept any source.
  images: {
    unoptimized: true,
    dangerouslyAllowSVG: true,
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "**" },
    ],
  },
};

export default config;
