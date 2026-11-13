import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // libsql خارج الباندلينج — يحتفظ بترابطه الأصلي في بيئة Vercel serverless
  serverExternalPackages: ["@libsql/client"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
