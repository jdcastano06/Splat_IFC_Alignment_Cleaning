import "./globals.css";

export const metadata = {
  title: "Splat ↔ IFC",
  description: "Align a Gaussian-splat scan to its IFC room, crop it to the walls, export.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23111214'/%3E%3Cpath d='M9 11l7-4 7 4v10l-7 4-7-4z' fill='none' stroke='%2326A69A' stroke-width='2' stroke-linejoin='round'/%3E%3Ccircle cx='16' cy='16' r='2.5' fill='%23FB8C00'/%3E%3C/svg%3E",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/* The theme names Figtree but never loads it; a plain link keeps the family name intact. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
