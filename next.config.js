/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['puppeteer', '@sparticuz/chromium', 'sharp']
  }
}

export default nextConfig
