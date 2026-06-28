import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import { TenantBranding } from "@flashbite/web-shared";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });

export const metadata: Metadata = {
  title: "FlashBite Admin",
  description: "Cross-tenant operations grid.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${manrope.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <TenantBranding />
        {children}
      </body>
    </html>
  );
}
