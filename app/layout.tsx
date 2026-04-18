import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Orbit.bet Prototype',
  description: 'Casino-style fake balance prototype with working mini games.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
