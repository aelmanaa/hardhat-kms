---
"hardhat-kms-gcp": patch
---

A failed credentials lookup no longer stays for the life of the signer. The Cloud KMS client keeps the result of its first initialization, a failure included, so after a passing failure, such as a metadata server that did not answer in time, every later call failed with the same error. The adapter now closes a client whose initialization failed, and the next call creates a new one, which looks the credentials up again. The failing call still reports the same `gcp.connect.*` error.
