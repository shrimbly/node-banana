import type { Metadata } from "next";
import "./globals.css";
import { Toast } from "@/components/Toast";

export const metadata: Metadata = {
  title: "Node Banana - AI Image Workflow",
  description: "Node-based image annotation and generation workflow using Nano Banana Pro",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Electron's preload adds a platform styling attribute before hydration.
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        {children}
        <Toast />
      </body>
    </html>
  );
}
