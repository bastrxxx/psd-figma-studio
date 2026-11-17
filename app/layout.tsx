import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PSD Figma Studio',
  description: 'Đọc file PSD (layer, text…), chỉnh sửa layer, lưu database và xuất sang Figma.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
