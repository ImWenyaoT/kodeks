import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kodeks Chat",
  description: "Minimal chat UI for the kodeks FastAPI coding-agent demo."
};

// Defines the root document shell for the Next.js app.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
