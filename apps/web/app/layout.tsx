import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "../components/auth";

export const metadata: Metadata = {
  title: "Quiz Live",
  description: "Real-time, server-authoritative live quizzes for events and classrooms",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}