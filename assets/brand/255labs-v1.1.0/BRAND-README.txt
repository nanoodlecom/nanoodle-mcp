255labs Brand System v1.1.0

Full signal. Zero noise.

AI-native products & consulting

255labs puts AI to work on real business problems. Our skill is knowing where it helps, choosing the right approach, and combining it with sound engineering and human judgment. We advise, build, and create products of our own.

Brand promise: Make AI useful.

Primary identity: the FF mark with the 255labs wordmark.
Use Signal (#D7FF3F) or Paper (#F1F2EA) on Ink (#101110).
Use Ink on Paper or Signal. Never stretch, rotate, outline, or add effects.
Keep clear space of one stem width (22/168 of the mark width) on every side.
Minimum FF width: 24px digital / 6mm print. Minimum lockup width: 120px digital.
The 0xFF signature is a supporting element; introduce the name 255labs first.

Manrope: headings and body. IBM Plex Mono: labels, numbers, and technical detail.
Both are distributed under the SIL Open Font License; see the included licenses.
SVG wordmarks have outlined paths and do not require installed fonts.
PNG monograms: 1008 x 672 transparent. PNG lockups: 1720 x 448 transparent.
Avatar: 512 x 512. Social cover: 1200 x 630.

Include 255labs-tokens.css in your project to load the fonts and shared tokens.
Use brand-color-ink for text on brand-color-signal. Never use Paper text on Signal.
Stone is secondary text on Ink. Divider is decorative, never essential UI.

Product endorsement: [product name] / by 255labs. Products can have their own accent
but share typography, spacing, and the parent-brand endorsement.

These brand assets are provided for representing 255labs and its projects.
They are not a grant to impersonate the company or claim endorsement.

SHARED UI / VERSION 1.1.0
Load 255labs-tokens.css, then 255labs-ui.css. Use class="brand-ui" on your app
root and data-brand-theme="dark" or "light". Use --brand-ui-* semantic roles
for UI; raw --brand-color-* values are the palette for artwork.
The theme defines background, surfaces, text, controls, actions, focus, and status
colors. Status always includes a text label. Product accents may vary; pair and
check their foreground/background colors in each theme.
Body: 16px / 1.7. Labels: 12px Mono. Controls: at least 44px high.
The HTML/JS example demonstrates filtering, item actions, validation, and
empty/loading/error states. It is fictional sample data, with no AI service.
Serve this folder with any static server (e.g. python3 -m http.server 8000),
then open 255labs-app-example.html. Include its JS only when using the example.
No runtime framework, account, or external font request is required.

ADOPTING A RELEASE
Keep this bundle together in your app source. 255labs-manifest.json records
the version and SHA-256 of each file. Pin an explicit version and verify the
hashes when copying; do not hotlink an unversioned stylesheet. Upgrade the
bundle deliberately and check both themes and keyboard behavior.
Favicons: SVG, ICO, and 16/32px PNG. Avatar PNG can serve as an app/touch icon.

Full guide: https://branding.255labs.xyz
