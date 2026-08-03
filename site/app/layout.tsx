import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Enqiu — Queues without ceremony";
const description =
  "A type-safe job queue for browsers, Node.js, and Bun. Start in memory, move to Redis without changing your job API.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);

  return {
    title,
    description,
    metadataBase,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

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
