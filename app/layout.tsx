
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HOPE AI Deriv Analyzer PRO",
  description: "Live Deriv market analysis and trading assistant"
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
