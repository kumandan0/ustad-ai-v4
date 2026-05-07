/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // Vercel build sırasında ESLint (kullanılmayan değişken vb.) hatalarını yoksayar
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Vercel build sırasında TypeScript (veri tipi) hatalarını yoksayar
    ignoreBuildErrors: true,
  },
};

export default nextConfig;