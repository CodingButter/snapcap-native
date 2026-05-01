import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const isProd = process.env.NODE_ENV === 'production';
// GitHub Pages serves this site at /snapcap-native/. Local dev runs at /.
const basePath = isProd ? '/snapcap-native' : '';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default withMDX(config);
