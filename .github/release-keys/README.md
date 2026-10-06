# Release keys

This directory is the trust root of the release pipeline. Every `.asc` file in it is the armored OpenPGP public key of one maintainer, named after their GitHub login (`<login>.asc`). A release starts from a `vX.Y.Z` tag, and the first job of the release workflow runs `scripts/verify-release-tag.ts`, which accepts the tag only when a key from this directory signed it. A tag that is lightweight, annotated but unsigned, or signed by any other key stops the workflow before anything is built.

Only public keys live here. The private half stays on the maintainer's hardware key. A pull request that adds a file containing `PRIVATE KEY` must not be merged, and the verification script refuses such a file.

## Add a maintainer

1. The maintainer exports the public key of the OpenPGP key they sign tags with:

   ```sh
   gpg --armor --export <key-id> > .github/release-keys/<github-login>.asc
   ```

2. They open a pull request that adds the file and nothing else. The pull request body names the key's fingerprint (`gpg --fingerprint <key-id>`) so a reviewer can compare it with the fingerprint shown on the maintainer's GitHub profile under GPG keys.
3. An existing maintainer reviews the fingerprint and merges. From the next tag on, that key can cut a release.

Removing a maintainer is the reverse: a pull request that deletes the file.

## Check a tag locally

```sh
git fetch origin main
node scripts/verify-release-tag.ts v1.2.3
```

The script imports the keys into a temporary `GNUPGHOME`, so it never touches your own keyring, and prints one line that says why a tag fails.
