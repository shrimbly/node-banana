import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Toast } from "@/components/Toast";
import { GenerationToaster } from "@/components/GenerationToast";

/**
 * The site's two faces, self-hosted at build time. Space Grotesk carries
 * dialog headings and buttons, JetBrains Mono the small uppercase labels;
 * body copy stays on the system stack (globals.css).
 */
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-space-grotesk", display: "swap" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains-mono", display: "swap" });

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
    // The font variables sit on <html>: the theme's --font-display and
    // --font-mono are defined on :root and resolve var() there, so a
    // variable declared further down (on body) would not be seen.
    <html lang="en" className={`dark ${spaceGrotesk.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body className="antialiased">
        {children}
        <Toast />
        <GenerationToaster />
      </body>
    </html>
  );
}
