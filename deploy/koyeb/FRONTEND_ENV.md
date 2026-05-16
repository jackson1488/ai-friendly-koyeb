# Frontend API env

For production web/native build:

```env
EXPO_PUBLIC_API_BASE_URL=https://api.ai-friendly.site
EXPO_PUBLIC_API_FALLBACK_URLS=https://server.ai-friendly.site,https://your-cloudflare-tunnel.trycloudflare.com,http://192.168.x.x:4000
```

Recommended order:

1. Koyeb stable API: `https://api.ai-friendly.site`
2. Old tunnel/backend fallback: `https://server.ai-friendly.site` or cloudflare tunnel
3. Local LAN fallback for development: `http://192.168.x.x:4000`

Do not use `localhost` for Expo Go on a physical phone. On phone, `localhost` means the phone itself, not your PC.
