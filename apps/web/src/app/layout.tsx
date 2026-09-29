import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DevPulse — Engineering Intelligence Platform',
  description:
    'DevPulse connects to GitHub, synchronizes repository activity, and presents actionable engineering analytics through an interactive dashboard.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
