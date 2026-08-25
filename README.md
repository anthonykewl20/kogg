# Kogg

Kogg is an engineering control plane for autonomous software development. It is
built on the Eclipse Theia platform, uses the Kogg Marketplace exclusively, and
ships the Ranex deterministic governance kernel as a mandatory system component.

## Development

On macOS, prepare the machine and repository with:

```sh
./scripts/bootstrap-macos.sh
yarn doctor
```

Start the browser application and local signed registry fixture:

```sh
yarn dev
```

Start the Electron application separately with `yarn dev:electron`.

## Trust boundaries

- Marketplace extensions run outside the Ranex authority boundary.
- Ranex is bundled, version-pinned, and unavailable through the marketplace.
- Kogg does not fall back to Open VSX or arbitrary registries.
- Provider credentials never enter workspace preferences or plugin environments.

See [docs/kogg-features.md](docs/kogg-features.md) for the product direction.
