import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900"
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900"
});

export const metadata: Metadata = {
  title: "Kodeks",
  description: "Kodeks local-first coding agent frontend."
};

// 定义 Next.js 应用的根文档外壳。
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <div className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-gray-200 text-stone-900">
          <main className="min-h-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
