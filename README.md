# Underplay — 表の城

AIツール開発者向けポートフォリオ＆自作ツール配布サイト。

## Tech Stack

- **Next.js 16** (App Router)
- **TypeScript**
- **Tailwind CSS v4**
- **lucide-react** (icons)

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Command         | Description              |
| --------------- | ------------------------ |
| `npm run dev`   | Start development server |
| `npm run build` | Production build         |
| `npm run start` | Start production server  |
| `npm run lint`  | Run ESLint               |

## Project Structure

```
src/
├── app/
│   ├── globals.css      # Theme & custom utilities
│   ├── layout.tsx       # Root layout + metadata
│   └── page.tsx         # Landing page
├── components/
│   ├── Header.tsx       # Fixed navigation
│   ├── Hero.tsx         # Hero section
│   ├── Products.tsx     # Tool distribution cards
│   ├── Articles.tsx     # Article link grid
│   ├── Contact.tsx      # Inquiry form
│   ├── DownloadButton.tsx
│   └── Footer.tsx
└── lib/
    └── data.ts          # Site content & config
```

## Customization

- **Colors / theme**: `src/app/globals.css`
- **Products, articles, nav**: `src/lib/data.ts`
- **Contact form backend**: wire up `Contact.tsx` submit handler to your API or form service (e.g. Resend, Formspree)

## Design

Cyber-minimal Underplay style:

- Base: `#121214`
- Accent: Neon Pink `#ff2a85`, Neon Violet `#8b5cf6`
