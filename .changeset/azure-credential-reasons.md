---
"@hardhat-kms/azure": patch
---

When no Azure credential returns a token, the `azure.credential.none` error now gives one reason per source of the chain, in the order the plugin tries them. A source can be not set up, not installed, not signed in, or blocked by a claims challenge. The managed identity can also report that its endpoint gave no token. For a claims challenge, the reason gives the `az login --claims-challenge` or `azd auth login` command to run. A failure the plugin does not recognise is reported without its text, because that text can name the tenant. The error used to give only a class name.

Issue: [#641](https://github.com/aelmanaa/hardhat-kms/issues/641)
