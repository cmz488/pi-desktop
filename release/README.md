# Release artifacts

`pi-desktop-extension-0.28.21.tgz` is the npm package built from this tree with
`npm pack`. It installs the `pi-desktop` / `pi-web` / `pi-desk` launchers.

```bash
npm install --global --allow-scripts=agent-browser,electron ./release/pi-desktop-extension-0.28.21.tgz
pi-desktop --port 4318
```

SHA-256: `f1b76ab3c3ff2f0e4d17756f29b8a91205418f18c768485fb1d7ba24a24408e1`