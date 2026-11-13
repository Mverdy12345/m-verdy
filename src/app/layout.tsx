import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";

// خط عربي جيد من Google Fonts
const cairo = Cairo({ subsets: ["arabic", "latin"], weight: ["400", "600", "700", "800"] });

export const metadata: Metadata = {
  title: "MCP Media Generator — لوحة الإدارة",
  description: "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع + لوحة إدارة عربية",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html dir="rtl" lang="ar">
      <body className={`${cairo.className} antialiased`}>{children}</body>
    </html>
  );
}
