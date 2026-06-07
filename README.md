# Before They Were Basic

A static Spotify web app that scans a user's liked songs, scores them from obscure to basic, creates Spotify playlists, and generates a music taste iceberg meme.

## Spotify Redirect URIs

Add these in Spotify Developer Dashboard:

- https://beforetheywerebasic.com/
- https://www.beforetheywerebasic.com/
- http://127.0.0.1:5500/

Also add your Cloudflare Pages preview URL after the first deployment.

## Local test

```bash
python -m http.server 5500
```

Open:

```text
http://127.0.0.1:5500/
```

## Cloudflare Pages

Build command: leave blank
Output directory: /
