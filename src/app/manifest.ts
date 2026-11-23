import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/everloop',
    name: 'Everloop',
    short_name: 'Everloop',
    start_url: '/inbox',
    scope: '/',
    display: 'standalone',
    background_color: '#14211b',
    theme_color: '#133b2b',
    icons: [
      { src: '/everloop/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/everloop/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/everloop/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
