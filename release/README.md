# Release artifacts

`pi-desktop-extension-0.28.20.tgz` is the npm package built from this tree with
`npm pack`. It installs the `pi-desktop` / `pi-web` / `pi-desk` launchers.

```bash
npm install --global --allow-scripts=agent-browser,electron ./release/pi-desktop-extension-0.28.20.tgz
pi-desktop --port 4318
```

SHA-256: `8d35344ae4eb875057f61128f2ba247a6489dd9c9652b7b47ed7464465d47175`
