# Fonts for the social preview

`pnpm run docs:og` renders `docs/public/og-image.svg` with these files only (`scripts/og-image.ts`). They are whole static TTF files, unchanged from the upstream releases, each family under the SIL Open Font License 1.1 in its `OFL.txt`.

| File                                        | Source                                                                                                                             | SHA-256                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `inter/Inter-Regular.ttf`                   | [Inter v4.1](https://github.com/rsms/inter/releases/tag/v4.1), `extras/ttf/` in `Inter-4.1.zip`                                    | `40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82` |
| `inter/Inter-SemiBold.ttf`                  | Inter v4.1, as above                                                                                                               | `78a843fade9d4612a5567302fb595b56976eb5fcebf4fea5a5912d638bafcde3` |
| `inter/Inter-Bold.ttf`                      | Inter v4.1, as above                                                                                                               | `288316099b1e0a47a4716d159098005eef7c0066921f34e3200393dbdb01947f` |
| `jetbrains-mono/JetBrainsMono-SemiBold.ttf` | [JetBrains Mono v2.304](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304), `fonts/ttf/` in `JetBrainsMono-2.304.zip` | `1b3bfa1ed5665a4ce3f9feb68d2d4e40e70bf8b4b7d9a3edd418f321b4e166a0` |

To check a file against its release: `shasum -a 256 tools/docs-site/fonts/*/*.ttf`.
