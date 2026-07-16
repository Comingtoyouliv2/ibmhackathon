import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Contract Radar — PR Pair Conflict Detection",
  description: "Find Git text conflicts and semantic contract conflicts between independently passing pull requests.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
