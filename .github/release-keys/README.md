# Release keys

This directory is the trust root of the release pipeline. Every `.asc` file in it is the armored OpenPGP public key of one maintainer, named after their GitHub login (`<login>.asc`). A release starts from a `vX.Y.Z` tag. The release workflow (#47) runs `scripts/verify-release-tag.ts` as its first job and accepts the tag only when a key from this directory signed it; a tag that is lightweight, annotated but unsigned, or signed by any other key stops the workflow before anything is built. Until that workflow exists, run the script by hand before pushing a tag (see "Check a tag locally").

Only public keys live here. The private half stays on the maintainer's hardware key. A pull request that adds a file containing `PRIVATE KEY` must not be merged, and the verification script refuses such a file.

## Add a maintainer

1. The maintainer exports the public key of the OpenPGP key they sign tags with:

   ```sh
   gpg --armor --export <key-id> > .github/release-keys/<github-login>.asc
   ```

   Export the whole key, not a subkey alone: the script matches the primary key's fingerprint, so a tag signed by a signing subkey of that key passes.

2. They open a pull request that adds the file and nothing else. The pull request body names the key's fingerprint (`gpg --fingerprint <key-id>`). A reviewer checks that GitHub serves the same key for that account: `curl -fsSL https://github.com/<github-login>.gpg | gpg --show-keys` prints the fingerprint of every key the maintainer has added to their GitHub account, and one of them must match.
3. An existing maintainer reviews the fingerprint and merges. From the next tag on, that key can cut a release.

Removing a maintainer is the reverse: a pull request that deletes the file.

## Check a tag locally

```sh
git fetch origin main
node scripts/verify-release-tag.ts v1.2.3
```

The script imports the keys into a temporary `GNUPGHOME`, so it never touches your own keyring, and prints one line: the signer, version and commit when the tag passes, or the reason it fails.
