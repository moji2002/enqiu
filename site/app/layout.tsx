import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Enqiu — The job queue that feels like a function";
const description =
  "A small, type-safe job queue for Node.js and Bun. Start in memory, move to Redis without changing your job API.";

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
    openGraph: {
      title: "Enqiu — Queues without ceremony",
      description:
        "Type-safe background jobs with memory and Redis drivers for Node.js and Bun.",
      type: "website",
      images: [
        {
          url: "/og.png",
          width: 1733,
          height: 907,
          alt: "Enqiu — Queues without ceremony",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Enqiu — Queues without ceremony",
      description:
        "Type-safe background jobs with memory and Redis drivers for Node.js and Bun.",
      images: ["/og.png"],
    },
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
